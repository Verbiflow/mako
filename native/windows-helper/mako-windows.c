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
//   mako-windows trusted <path>...       whether the program at each path (or any in a folder) is this user's choice:
//                                        the file, the folder holding it and every folder above, each where it really
//                                        is through links, owned by this user, SYSTEM, Administrators or
//                                        TrustedInstaller; no one else may write the file, add to or replace in its
//                                        folder (files it inherits included), or delete, rename or re-own a folder
//                                        above. Prints "trusted" or "untrusted <why>".
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

/**
 * The SID an allow ACE grants to, for every kind of allow ACE (plain, callback, object, callback object); NULL for any
 * other kind. An object ACE's SID follows the GUIDs its flags say are present.
 */
static PSID allowed_sid(ACE_HEADER *header, ACCESS_MASK *mask) {
  switch (header->AceType) {
    case ACCESS_ALLOWED_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_ACE_TYPE: {
      ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
      *mask = ace->Mask;
      return (PSID)&ace->SidStart;
    }
    case ACCESS_ALLOWED_OBJECT_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE: {
      ACCESS_ALLOWED_OBJECT_ACE *ace = (ACCESS_ALLOWED_OBJECT_ACE *)header;
      BYTE *at = (BYTE *)&ace->ObjectType;
      if (ace->Flags & ACE_OBJECT_TYPE_PRESENT) at += sizeof(GUID);
      if (ace->Flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) at += sizeof(GUID);
      *mask = ace->Mask;
      return (PSID)at;
    }
    default:
      return NULL;
  }
}

/** Write to a file: its data, its permissions or owner, or deleting it. */
#define FILE_WRITES (FILE_WRITE_DATA | FILE_APPEND_DATA | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL)
/** The folder holding the program: nobody else may add to it, replace or delete in it, or take it. */
#define FOLDER_WRITES (FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL)
/**
 * A folder above it: nobody else may delete or rename what's in it, or take it. Making a new folder there, as every
 * user may at `C:\`, changes nothing already on the path.
 */
#define ABOVE_WRITES (FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL)

/**
 * "" when `path`'s owner and DACL leave `mask` to trusted SIDs; else why not. With `files_inside`, an ACE only for what
 * is made inside (inherit-only) counts too when files inherit it and it lets them be written: a file made there later,
 * or one made by a trusted account, would be writable by another.
 */
static const wchar_t *check(const wchar_t *path, ACCESS_MASK mask, BOOL files_inside, wchar_t *why, size_t size) {
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
      ACCESS_MASK granted = 0;
      if (!GetAce(dacl, index, (LPVOID *)&header)) continue;
      PSID sid = allowed_sid(header, &granted);
      if (!sid) continue;
      ACCESS_MASK applies = mask;
      if (header->AceFlags & INHERIT_ONLY_ACE) {
        // CREATOR OWNER's inherit-only grant goes to whoever makes the file, whose ownership is checked itself.
        if (!files_inside || !(header->AceFlags & OBJECT_INHERIT_ACE) || sid_is(sid, L"S-1-3-0")) continue;
        applies = FILE_WRITES;
      }
      if ((granted & applies) && !trusted_sid(sid)) {
        LPWSTR text = NULL;
        ConvertSidToStringSidW(sid, &text);
        swprintf(why, size, L"writable by %ls %ls", text ? text : L"?", path);
        if (text) LocalFree(text);
      }
    }
  LocalFree(descriptor);
  return why;
}

/**
 * Where `path` really is, through every link and junction (`GetFinalPathNameByHandleW`), as a drive path; FALSE for
 * one that can't be opened, or is on a network share.
 */
static BOOL final_path(const wchar_t *path, wchar_t *out, DWORD size, wchar_t *why, size_t why_size) {
  HANDLE handle = CreateFileW(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    swprintf(why, why_size, L"unopenable %lu %ls", GetLastError(), path);
    return FALSE;
  }
  wchar_t raw[MAX_PATH * 4];
  DWORD length = GetFinalPathNameByHandleW(handle, raw, MAX_PATH * 4, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(handle);
  if (!length || length >= MAX_PATH * 4) {
    swprintf(why, why_size, L"unresolvable %lu %ls", GetLastError(), path);
    return FALSE;
  }
  if (wcsncmp(raw, L"\\\\?\\UNC\\", 8) == 0) {
    swprintf(why, why_size, L"on a network share %ls", path);
    return FALSE;
  }
  const wchar_t *drive = wcsncmp(raw, L"\\\\?\\", 4) == 0 ? raw + 4 : raw;
  swprintf(out, size, L"%ls", drive);
  return TRUE;
}

/** The folders above `folder`, each checked as one above: `C:\a\b` asks of `C:\a`, then `C:\`. */
static BOOL chain_holds(wchar_t *folder, wchar_t *why, size_t size) {
  for (;;) {
    size_t length = wcslen(folder);
    wchar_t *cut = wcsrchr(folder, L'\\');
    if (!cut || length <= 3) return TRUE;
    if (cut == folder + 2) folder[3] = 0;
    else *cut = 0;
    if (check(folder, ABOVE_WRITES, FALSE, why, size)[0]) return FALSE;
  }
}

/**
 * Whether a program at `path` (a file), or any program in `path` (a folder), is this user's choice: the file itself
 * and the folder holding it owned by this user, SYSTEM, Administrators or TrustedInstaller and writable by no one
 * else, files it inherits included; every folder above them likewise for deleting, renaming or re-owning. Each is
 * checked where it really is, through links and junctions.
 */
static void trusted(const wchar_t *path) {
  wchar_t real[MAX_PATH * 4], why[MAX_PATH * 4 + 64];
  if (!final_path(path, real, MAX_PATH * 4, why, sizeof(why) / sizeof(why[0]))) {
    wprintf(L"untrusted %ls\n", why);
    return;
  }
  DWORD attributes = GetFileAttributesW(real);
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    wprintf(L"untrusted unreadable %lu %ls\n", GetLastError(), real);
    return;
  }
  if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) {
    if (check(real, FILE_WRITES, FALSE, why, sizeof(why) / sizeof(why[0]))[0]) {
      wprintf(L"untrusted %ls\n", why);
      return;
    }
    wchar_t *cut = wcsrchr(real, L'\\');
    if (!cut) {
      wprintf(L"untrusted no folder %ls\n", real);
      return;
    }
    if (cut == real + 2) real[3] = 0;
    else *cut = 0;
  }
  if (check(real, FOLDER_WRITES, TRUE, why, sizeof(why) / sizeof(why[0]))[0] || !chain_holds(real, why, sizeof(why) / sizeof(why[0]))) {
    wprintf(L"untrusted %ls\n", why);
    return;
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
  fwprintf(stderr, L"usage: mako-windows sid | secure-pipe <pipe>... | trusted <path>...\n");
  return 2;
}
