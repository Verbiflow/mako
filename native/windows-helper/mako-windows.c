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
//   mako-windows trusted <path>... | -   whether the program at each path (or each line of stdin, UTF-8) is this
//                                        user's choice: where it really is, the file, the DLLs beside it, its folder
//                                        (files it hands down included) and every folder above, owned by this user,
//                                        SYSTEM, Administrators or TrustedInstaller and writable by no one else; as it
//                                        was named, every folder and link on the way beyond anyone else's repointing,
//                                        deleting or renaming. Prints "trusted <real path> <volume serial>:<file index>"
//                                        or "untrusted <why>".
//   mako-windows run-in-job <pid> <command line>
//                                        runs the command in a job that ends its whole tree when this helper ends:
//                                        with the command, or when process <pid> (its owner) is gone.
//
// Built with MSVC, /MT (scripts/build-windows-helper.mjs).
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <string.h>
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

/** SYSTEM, Administrators, TrustedInstaller, or this user. `sid` is valid. */
static BOOL trusted_sid(PSID sid) {
  PSID user = user_sid();
  return (user && EqualSid(sid, user)) || sid_is(sid, L"S-1-5-18") || sid_is(sid, L"S-1-5-32-544") ||
         sid_is(sid, L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
}

/** What an ACE says, read with every bound checked: not an allow, an allow to `sid` of `mask`, or malformed. */
typedef enum { ACE_OTHER, ACE_ALLOW, ACE_MALFORMED } AceKind;

/**
 * Reads an allow ACE of every kind (plain, callback, object, callback object): its mask and the SID it grants, which
 * must lie whole within the ACE and be valid. An object ACE's SID follows the GUIDs its flags say are present.
 */
static AceKind read_ace(ACE_HEADER *header, ACCESS_MASK *mask, PSID *sid) {
  BYTE *start = (BYTE *)header;
  BYTE *at;
  switch (header->AceType) {
    case ACCESS_ALLOWED_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_ACE_TYPE: {
      if (header->AceSize < sizeof(ACE_HEADER) + sizeof(ACCESS_MASK)) return ACE_MALFORMED;
      ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
      *mask = ace->Mask;
      at = (BYTE *)&ace->SidStart;
      break;
    }
    case ACCESS_ALLOWED_OBJECT_ACE_TYPE:
    case ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE: {
      if (header->AceSize < sizeof(ACE_HEADER) + sizeof(ACCESS_MASK) + sizeof(DWORD)) return ACE_MALFORMED;
      ACCESS_ALLOWED_OBJECT_ACE *ace = (ACCESS_ALLOWED_OBJECT_ACE *)header;
      at = (BYTE *)&ace->ObjectType;
      if (ace->Flags & ACE_OBJECT_TYPE_PRESENT) at += sizeof(GUID);
      if (ace->Flags & ACE_INHERITED_OBJECT_TYPE_PRESENT) at += sizeof(GUID);
      *mask = ace->Mask;
      break;
    }
    default:
      return ACE_OTHER;
  }
  size_t offset = (size_t)(at - start);
  // A SID's fixed part is 8 bytes, its sub-authority count the second; all of it must lie within the ACE.
  if (offset + 8 > header->AceSize) return ACE_MALFORMED;
  if (offset + GetSidLengthRequired(at[1]) > header->AceSize || !IsValidSid((PSID)at)) return ACE_MALFORMED;
  *sid = (PSID)at;
  return ACE_ALLOW;
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
/** A link or junction itself: nobody else may repoint it (its data or attributes), delete it or take it. */
#define LINK_WRITES (FILE_WRITE_DATA | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL)

#define WHY 8192

/**
 * Whether `path`'s owner and DACL leave `mask` to trusted SIDs; `why` says why not. `link` reads the link or junction
 * at `path` itself rather than what it leads to. With `files_inside`, an inherit-only ACE counts too when files
 * inherit it and it lets them be written: a file made there later would be writable by another. A DACL that can't be
 * read, or an ACE that can't be, is never trusted.
 */
static BOOL check(const wchar_t *path, ACCESS_MASK mask, BOOL files_inside, BOOL link, wchar_t *why) {
  HANDLE handle = CreateFileW(path, READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | (link ? FILE_FLAG_OPEN_REPARSE_POINT : 0), NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    swprintf(why, WHY, L"unopenable %lu %ls", GetLastError(), path);
    return FALSE;
  }
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD read = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &descriptor);
  CloseHandle(handle);
  if (read != ERROR_SUCCESS) {
    swprintf(why, WHY, L"unreadable %lu %ls", read, path);
    return FALSE;
  }
  BOOL holds = FALSE;
  if (!owner || !IsValidSid(owner) || !trusted_sid(owner)) swprintf(why, WHY, L"owned by another %ls", path);
  else if (!dacl) swprintf(why, WHY, L"no DACL %ls", path);
  else {
    holds = TRUE;
    for (DWORD index = 0; index < dacl->AceCount && holds; index++) {
      ACE_HEADER *header = NULL;
      ACCESS_MASK granted = 0;
      PSID sid = NULL;
      if (!GetAce(dacl, index, (LPVOID *)&header)) {
        swprintf(why, WHY, L"an unreadable ACE %ls", path);
        holds = FALSE;
        break;
      }
      AceKind kind = read_ace(header, &granted, &sid);
      if (kind == ACE_OTHER) continue;
      if (kind == ACE_MALFORMED) {
        swprintf(why, WHY, L"a malformed ACE %ls", path);
        holds = FALSE;
        break;
      }
      ACCESS_MASK applies = mask;
      if (header->AceFlags & INHERIT_ONLY_ACE) {
        // CREATOR OWNER's inherit-only grant goes to whoever makes the file, whose ownership is checked itself.
        if (!files_inside || !(header->AceFlags & OBJECT_INHERIT_ACE) || sid_is(sid, L"S-1-3-0")) continue;
        applies = FILE_WRITES;
      }
      if ((granted & applies) && !trusted_sid(sid)) {
        LPWSTR text = NULL;
        ConvertSidToStringSidW(sid, &text);
        swprintf(why, WHY, L"writable by %ls %ls", text ? text : L"?", path);
        if (text) LocalFree(text);
        holds = FALSE;
      }
    }
  }
  LocalFree(descriptor);
  return holds;
}

/** Cuts `folder` to the one above it in place: `C:\a\b` to `C:\a`, `C:\a` to `C:\`; FALSE at the root. */
static BOOL up(wchar_t *folder) {
  size_t length = wcslen(folder);
  wchar_t *cut = wcsrchr(folder, L'\\');
  if (!cut || length <= 3) return FALSE;
  if (cut == folder + 2) folder[3] = 0;
  else *cut = 0;
  return TRUE;
}

/**
 * Where `path` really is, through every link and junction (`GetFinalPathNameByHandleW`), as a drive path, with the
 * file's identity (its volume's serial and its index there); FALSE for one that can't be opened, or is on a share.
 */
static BOOL final_path(const wchar_t *path, wchar_t *out, DWORD size, wchar_t *identity, wchar_t *why) {
  HANDLE handle = CreateFileW(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    swprintf(why, WHY, L"unopenable %lu %ls", GetLastError(), path);
    return FALSE;
  }
  wchar_t raw[MAX_PATH * 4];
  BY_HANDLE_FILE_INFORMATION info;
  DWORD length = GetFinalPathNameByHandleW(handle, raw, MAX_PATH * 4, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  BOOL known = GetFileInformationByHandle(handle, &info);
  CloseHandle(handle);
  if (!length || length >= MAX_PATH * 4 || !known) {
    swprintf(why, WHY, L"unresolvable %lu %ls", GetLastError(), path);
    return FALSE;
  }
  if (wcsncmp(raw, L"\\\\?\\UNC\\", 8) == 0) {
    swprintf(why, WHY, L"on a network share %ls", path);
    return FALSE;
  }
  const wchar_t *drive = wcsncmp(raw, L"\\\\?\\", 4) == 0 ? raw + 4 : raw;
  swprintf(out, size, L"%ls", drive);
  swprintf(identity, 64, L"%08lx:%08lx%08lx", info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow);
  return TRUE;
}

/** Each DLL beside the program, which Windows loads from its folder first: none may be another's to write. */
static BOOL dlls_hold(const wchar_t *folder, wchar_t *why) {
  wchar_t pattern[MAX_PATH * 4 + 8], file[MAX_PATH * 4 + 260];
  swprintf(pattern, MAX_PATH * 4 + 8, L"%ls\\*.dll", folder);
  WIN32_FIND_DATAW found;
  HANDLE search = FindFirstFileW(pattern, &found);
  if (search == INVALID_HANDLE_VALUE) return TRUE;
  BOOL holds = TRUE;
  do {
    if (found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
    swprintf(file, MAX_PATH * 4 + 260, L"%ls\\%ls", folder, found.cFileName);
    holds = check(file, FILE_WRITES, FALSE, FALSE, why);
  } while (holds && FindNextFileW(search, &found));
  FindClose(search);
  return holds;
}

/**
 * Whether the program at `path` is this user's choice. Where it really is (through links and junctions): the file,
 * the DLLs beside it, the folder holding it (files it hands down included) and every folder above, owned by this user,
 * SYSTEM, Administrators or TrustedInstaller and writable by no one else. And as it was named: every folder on that
 * path, links and junctions read as themselves, beyond anyone else's repointing, deleting or renaming. Prints
 * `trusted <where it really is> <volume serial>:<file index>`, which is what is started and kept, or `untrusted <why>`.
 */
static void trusted(const wchar_t *path) {
  static wchar_t written[MAX_PATH * 4], real[MAX_PATH * 4], folder[MAX_PATH * 4], why[WHY];
  wchar_t identity[64];
  if (!GetFullPathNameW(path, MAX_PATH * 4, written, NULL)) {
    wprintf(L"untrusted unnamed %lu\n", GetLastError());
    return;
  }
  // As named: each folder from the program's own up, a link or junction read as itself.
  swprintf(folder, MAX_PATH * 4, L"%ls", written);
  while (up(folder)) {
    DWORD attributes = GetFileAttributesW(folder);
    BOOL link = attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT);
    if (!check(folder, link ? LINK_WRITES : ABOVE_WRITES, FALSE, link, why)) {
      wprintf(L"untrusted %ls\n", why);
      return;
    }
  }
  DWORD named = GetFileAttributesW(written);
  if (named != INVALID_FILE_ATTRIBUTES && (named & FILE_ATTRIBUTE_REPARSE_POINT) && !check(written, LINK_WRITES, FALSE, TRUE, why)) {
    wprintf(L"untrusted %ls\n", why);
    return;
  }
  // Where it really is.
  if (!final_path(written, real, MAX_PATH * 4, identity, why)) {
    wprintf(L"untrusted %ls\n", why);
    return;
  }
  DWORD attributes = GetFileAttributesW(real);
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY)) {
    wprintf(L"untrusted not a program %ls\n", real);
    return;
  }
  if (!check(real, FILE_WRITES, FALSE, FALSE, why)) {
    wprintf(L"untrusted %ls\n", why);
    return;
  }
  swprintf(folder, MAX_PATH * 4, L"%ls", real);
  if (!up(folder) || !check(folder, FOLDER_WRITES, TRUE, FALSE, why) || !dlls_hold(folder, why)) {
    wprintf(L"untrusted %ls\n", why[0] ? why : L"no folder");
    return;
  }
  while (up(folder))
    if (!check(folder, ABOVE_WRITES, FALSE, FALSE, why)) {
      wprintf(L"untrusted %ls\n", why);
      return;
    }
  wprintf(L"trusted %ls %ls\n", real, identity);
}

/** Paths to ask about, one a line on stdin (UTF-8), so no command line's length bounds a batch. */
static void trusted_from_stdin(void) {
  static char line[MAX_PATH * 12];
  static wchar_t path[MAX_PATH * 4];
  while (fgets(line, sizeof(line), stdin)) {
    size_t length = strlen(line);
    while (length && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = 0;
    if (!length) continue;
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, line, -1, path, MAX_PATH * 4)) {
      wprintf(L"untrusted unreadable path\n");
      continue;
    }
    trusted(path);
    fflush(stdout);
  }
}

/**
 * `run-in-job <owner pid> <command line>`: runs the command in a job object of this helper's that ends every process
 * in it when its last handle closes, which is when this helper ends, however it ends. The command line is the rest of
 * this process's own, passed on as written, and the command gets this helper's standard handles and every other
 * handle its starter passed down (`STARTUPINFO`, as received). The helper ends, and the job with it, when the command
 * ends (with its exit code) or when the owner does: a host that is killed outright leaves none of its children's
 * trees behind, and ending this helper ends the whole tree with no parent pids to follow. A command that makes jobs
 * of its own nests them inside (Windows 8 and later).
 */
static int run_in_job(void) {
  const wchar_t *line = GetCommandLineW();
  const wchar_t *at = wcsstr(line, L" run-in-job ");
  if (!at) return 2;
  at += wcslen(L" run-in-job ");
  while (*at == L' ') at++;
  DWORD owner = 0;
  while (*at >= L'0' && *at <= L'9') owner = owner * 10 + (DWORD)(*at++ - L'0');
  while (*at == L' ') at++;
  if (!owner || !*at) return 2;
  size_t length = wcslen(at) + 1;
  wchar_t *command = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, length * sizeof(wchar_t));
  if (!command) return 1;
  memcpy(command, at, length * sizeof(wchar_t));

  HANDLE host = OpenProcess(SYNCHRONIZE, FALSE, owner);
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // Where this process can't join a job (one it is already in forbids nesting), the command runs without one.
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) || !AssignProcessToJobObject(job, GetCurrentProcess())) {
      CloseHandle(job);
      job = NULL;
    }
  }
  STARTUPINFOW startup;
  GetStartupInfoW(&startup);
  PROCESS_INFORMATION started;
  if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &started)) {
    fwprintf(stderr, L"mako-windows: the command couldn't start (%lu)\n", GetLastError());
    return 127;
  }
  CloseHandle(started.hThread);
  HANDLE waited[2] = { started.hProcess, host };
  DWORD which = WaitForMultipleObjects(host ? 2 : 1, waited, FALSE, INFINITE);
  DWORD code = 1;
  // The owner ended first: leaving closes the job, which ends the command and everything it started.
  if (which == WAIT_OBJECT_0) GetExitCodeProcess(started.hProcess, &code);
  return (int)code;
}

int wmain(int argc, wchar_t **argv) {
  // Paths go out as UTF-8, whatever the console's code page.
  if (argc >= 4 && wcscmp(argv[1], L"run-in-job") == 0) return run_in_job();
  _setmode(_fileno(stdout), _O_U8TEXT);
  if (argc >= 2 && wcscmp(argv[1], L"sid") == 0) return print_sid();
  if (argc >= 3 && wcscmp(argv[1], L"secure-pipe") == 0) {
    for (int at = 2; at < argc; at++) secure_pipe(argv[at]);
    return 0;
  }
  if (argc == 3 && wcscmp(argv[1], L"trusted") == 0 && wcscmp(argv[2], L"-") == 0) {
    trusted_from_stdin();
    return 0;
  }
  if (argc >= 3 && wcscmp(argv[1], L"trusted") == 0) {
    for (int at = 2; at < argc; at++) trusted(argv[at]);
    return 0;
  }
  fwprintf(stderr, L"usage: mako-windows sid | secure-pipe <pipe>... | trusted <path>... | trusted -\n");
  return 2;
}
