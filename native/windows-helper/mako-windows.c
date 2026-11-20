// mako-windows: what Mako's host on Windows needs of Win32 that Node doesn't expose, as one small static .exe run by its
// whole path (packages/host/src/base/windows-helper.ts). Each command prints one line per argument and exits 0; a
// usage error exits 2.
//
//   mako-windows sid                     this process's user, as a SID string (S-1-5-21-...)
//   mako-windows secure-pipe <pipe>...   narrows each listening pipe's DACL to D:P(D;;FA;;;NU)(A;;FA;;;SY)(A;;FA;;;<user>):
//                                        network logons denied, only SYSTEM and this user allowed. Its owner opens it
//                                        with WRITE_DAC (SQOS identification: the server may not act as us) and sets
//                                        it there; a pipe's security is its name's, so later instances keep it.
//                                        Prints "secured" or "failed <step> <error>".
//   mako-windows trusted <folder>...     whether a program in each folder can be trusted to be this user's choice:
//                                        the folder and every folder above it are owned by this user, SYSTEM,
//                                        Administrators or TrustedInstaller, and no one else may add, replace or
//                                        delete in the folder, or delete, rename or re-own a folder above it.
//                                        Prints "trusted" or "untrusted <why>".
//
// Built with MSVC, /MT (scripts/build-windows-helper.mjs).
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <wchar.h>

#pragma comment(lib, "advapi32.lib")

static PSID user_sid(void) {
  static BYTE buffer[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
  HANDLE token;
  DWORD size = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
  BOOL ok = GetTokenInformation(token, TokenUser, buffer, sizeof(buffer), &size);
  CloseHandle(token);
  return ok ? ((TOKEN_USER *)buffer)->User.Sid : NULL;
}

static int print_sid(void) {
  PSID sid = user_sid();
  LPWSTR text = NULL;
  if (!sid || !ConvertSidToStringSidW(sid, &text)) {
    wprintf(L"failed sid %lu\n", GetLastError());
    return 1;
  }
  wprintf(L"%ls\n", text);
  LocalFree(text);
  return 0;
}

static void secure_pipe(const wchar_t *pipe) {
  LPWSTR sid_text = NULL;
  PSID sid = user_sid();
  if (!sid || !ConvertSidToStringSidW(sid, &sid_text)) {
    wprintf(L"failed sid %lu\n", GetLastError());
    return;
  }
  wchar_t sddl[256];
  swprintf(sddl, 256, L"D:P(D;;FA;;;NU)(A;;FA;;;SY)(A;;FA;;;%ls)", sid_text);
  LocalFree(sid_text);
  HANDLE handle = INVALID_HANDLE_VALUE;
  for (int attempt = 0; attempt < 200; attempt++) {
    handle = CreateFileW(pipe, READ_CONTROL | WRITE_DAC, 0, NULL, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (handle != INVALID_HANDLE_VALUE || GetLastError() != ERROR_PIPE_BUSY) break;
    WaitNamedPipeW(pipe, 25);
  }
  if (handle == INVALID_HANDLE_VALUE) {
    wprintf(L"failed open %lu\n", GetLastError());
    return;
  }
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL)) {
    wprintf(L"failed sddl %lu\n", GetLastError());
    CloseHandle(handle);
    return;
  }
  BOOL present = FALSE, defaulted = FALSE;
  PACL dacl = NULL;
  GetSecurityDescriptorDacl(descriptor, &present, &dacl, &defaulted);
  DWORD set = SetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, dacl, NULL);
  LocalFree(descriptor);
  CloseHandle(handle);
  if (set == ERROR_SUCCESS) wprintf(L"secured\n");
  else wprintf(L"failed set %lu\n", set);
}

static BOOL sid_is(PSID sid, const wchar_t *text) {
  PSID other = NULL;
  if (!ConvertStringSidToSidW(text, &other)) return FALSE;
  BOOL same = EqualSid(sid, other);
  LocalFree(other);
  return same;
}

/** SYSTEM, Administrators, TrustedInstaller, or this user. */
static BOOL trusted_sid(PSID sid) {
  PSID user = user_sid();
  return (user && EqualSid(sid, user)) || sid_is(sid, L"S-1-5-18") || sid_is(sid, L"S-1-5-32-544") ||
         sid_is(sid, L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
}

/** "" when `path`'s owner and DACL leave it to trusted SIDs; else why not. `mask` is what no one else may hold. */
static const wchar_t *check(const wchar_t *path, ACCESS_MASK mask, wchar_t *why, size_t size) {
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD read = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &descriptor);
  if (read != ERROR_SUCCESS) {
    swprintf(why, size, L"unreadable %lu %ls", read, path);
    return why;
  }
  why[0] = 0;
  if (!trusted_sid(owner)) swprintf(why, size, L"owned by another %ls", path);
  else if (!dacl) swprintf(why, size, L"no DACL %ls", path);
  else
    for (DWORD index = 0; index < dacl->AceCount && !why[0]; index++) {
      ACE_HEADER *header = NULL;
      if (!GetAce(dacl, index, (LPVOID *)&header) || header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
      // An ACE only for what is made inside applies to the folder's children, not to it.
      if (header->AceFlags & INHERIT_ONLY_ACE) continue;
      ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
      PSID sid = (PSID)&ace->SidStart;
      if ((ace->Mask & mask) && !trusted_sid(sid)) {
        LPWSTR text = NULL;
        ConvertSidToStringSidW(sid, &text);
        swprintf(why, size, L"writable by %ls %ls", text ? text : L"?", path);
        if (text) LocalFree(text);
      }
    }
  LocalFree(descriptor);
  return why;
}

static void trusted(const wchar_t *folder) {
  wchar_t full[MAX_PATH * 4], why[MAX_PATH * 4 + 64];
  if (!GetFullPathNameW(folder, MAX_PATH * 4, full, NULL)) {
    wprintf(L"untrusted unresolvable %lu\n", GetLastError());
    return;
  }
  // The folder itself: nobody else may add a file, write one, or take its permissions or ownership.
  const ACCESS_MASK in_folder = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_DELETE_CHILD | DELETE | WRITE_DAC |
                                WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL;
  // A folder above it: nobody else may delete or rename what's in it, or take its permissions or ownership. Making a
  // new folder there (as every user may at C:\) changes nothing already on the path.
  const ACCESS_MASK above = FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL;
  if (check(full, in_folder, why, sizeof(why) / sizeof(why[0]))[0]) {
    wprintf(L"untrusted %ls\n", why);
    return;
  }
  // Each folder above, to the drive's root: `C:\a\b` asks of `C:\a`, then `C:\`.
  for (;;) {
    size_t length = wcslen(full);
    wchar_t *cut = wcsrchr(full, L'\\');
    if (!cut || length <= 3) break;
    if (cut == full + 2) full[3] = 0;  // `C:\a` becomes the root, `C:\`
    else *cut = 0;
    if (check(full, above, why, sizeof(why) / sizeof(why[0]))[0]) {
      wprintf(L"untrusted %ls\n", why);
      return;
    }
  }
  wprintf(L"trusted\n");
}

int wmain(int argc, wchar_t **argv) {
  if (argc >= 2 && wcscmp(argv[1], L"sid") == 0) return print_sid();
  if (argc >= 3 && wcscmp(argv[1], L"secure-pipe") == 0) {
    for (int at = 2; at < argc; at++) secure_pipe(argv[at]);
    return 0;
  }
  if (argc >= 3 && wcscmp(argv[1], L"trusted") == 0) {
    for (int at = 2; at < argc; at++) trusted(argv[at]);
    return 0;
  }
  fwprintf(stderr, L"usage: mako-windows sid | secure-pipe <pipe>... | trusted <folder>...\n");
  return 2;
}
