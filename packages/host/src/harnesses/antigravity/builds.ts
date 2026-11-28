// Release files and SHA-512 digests from the vendor's platform manifests for antigravity 1.5.19, written by scripts/bump-harness-versions.ts.
/** The version every file below is: what Mako installs, and so what it declares tested. */
export const version = "1.5.19"
export const builds = {
  "darwin_arm64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/darwin-arm/cli_mac_arm64.tar.gz",
    "sha512": "d798b1b2f91eb88a43c304ea5075db13cb069f01219c3b9f370037dc2c89d7e6c36ee96f160f9019947c1f5b55e744d8102e8303271d618f70d71cdb0911b213"
  },
  "darwin_amd64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/darwin-x64/cli_mac_x64.tar.gz",
    "sha512": "c989fa40e36858cecebaa1223ed93fbb9aaaba6fbaf3697d5d397cd451b4eea9ba7cebb3b5a6faf8ddec6dbce3730bdfda98b1c182062a522a7b9ea875d30894"
  },
  "linux_amd64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/linux-x64/cli_linux_x64.tar.gz",
    "sha512": "8160da6ceef2b7b62bb4a630b54b3fb4ee5283377509230736880c4ba4815e848a25cf346954a98134b647eb2f5d34e0364e77fbf74367ffd7dc29c525ddd82d"
  },
  "linux_arm64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/linux-arm/cli_linux_arm64.tar.gz",
    "sha512": "eeecedfc2a63af281e245d73bb69f949a17c6d3ebcd3d023220056ddcc05e204a00d1d0ea77f68741b2fc15a1f66f740bc0e3bf800d734721c60938e61653010"
  },
  "linux_amd64_musl": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/linux-x64-musl/cli_linux_x64_musl.tar.gz",
    "sha512": "8a5541bc71900e7571ce2c5cfc637e6155ace45f108badd91ee235c1e8f122c034bd07e1efc6f18a77467075419102d99d03ac5b8033e271e0914d05adf60634"
  },
  "linux_arm64_musl": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/linux-arm-musl/cli_linux_arm64_musl.tar.gz",
    "sha512": "e5fbc849f6288556b1d8b7e0d0a70b763dd404ff9673c5ec7921937955793283d91e931e48779b0e8ac39f6973bf6b53e763279eb88a0dbd1deab6da37a1e411"
  },
  "windows_amd64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/windows-x64/cli_windows_x64.exe",
    "sha512": "122ce5ed90a0f0ec8a87fd3383e167ba4ab39afeb40ed8a302393f5da74c62883d915efa9fe8071eb2f00b37a1384354225b230ff345fac8d9d5bf70983ce1b8"
  },
  "windows_arm64": {
    "url": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-4821414830800896/windows-arm/cli_windows_arm64.exe",
    "sha512": "c0d8b034dc010b598139b301e7fec9f665538f08da6af3e8fa0868fb1f4ffcbe937d4e5bc6bb25d9f23b29908bc74cb444a10598b4021d1a0267be0467bee9c0"
  }
} as const
