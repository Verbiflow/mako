"""Print immutable source links and test declarations from a pinned T3 git checkout.
Usage: python3 index-orchestrator-evidence.py /path/to/t3code
This indexes evidence; it does not execute or certify upstream tests.
"""
import json
import re
import subprocess
import sys

REV = '415ed0f73b97f1655b6282492f81d0b2bba3a9cc'
ROOTS = ('docs/orchestration-v2/', 'apps/server/src/orchestration-v2/',
         'apps/server/src/mcp/', 'apps/server/src/scheduledTasks/')

def git(*args):
    return subprocess.check_output(['git', '-C', sys.argv[1], *args]).decode('utf-8')

rows = []
for path in git('ls-tree', '-r', '--name-only', REV, '--', *ROOTS).splitlines():
    if not (path.endswith('.test.ts') or path.endswith('.md')):
        continue
    source = git('show', f'{REV}:{path}')
    declarations = []
    for match in re.finditer(r'\bit\.(effect|live|skip)\(\s*"([^"\n]+)"', source):
        declarations.append({'line': source.count('\n', 0, match.start()) + 1,
                             'kind': match[1], 'name': match[2]})
    rows.append({'path': path, 'url': f'https://github.com/pingdotgg/t3code/blob/{REV}/{path}',
                 'test_declarations': declarations})
print(json.dumps({'revision': REV, 'tests_executed': False, 'files': rows}, indent=2))
