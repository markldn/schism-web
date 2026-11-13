#!/usr/bin/env python3
"""Compare every generated player table value with the C compiler's output."""
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT.parent / 'schismtracker/player/tables.c'
source = SOURCE.read_text()
arrays = re.findall(r'const\s+(uint8_t|uint16_t|uint32_t|int8_t|char\s*\*)\s*(\w+)\[(\d+)\]', source)
source = re.sub(r'^#include.*$', '', source, flags=re.M)
statements = []
for kind, name, count in arrays:
    fmt = '%s' if kind.startswith('char') else '%lld'
    value = f'{name}[i]' if kind.startswith('char') else f'(long long){name}[i]'
    statements.append(f'for (int i=0;i<{count};i++) printf("{fmt}\\n", {value});')
with tempfile.TemporaryDirectory() as directory:
    cfile = Path(directory) / 'tables.c'
    binary = Path(directory) / 'tables'
    cfile.write_text('#include <stdint.h>\n#include <stdio.h>\n' + source + '\nint main(void) {\n' + '\n'.join(statements) + '\n}\n')
    subprocess.run(['cc', str(cfile), '-o', str(binary)], check=True)
    expected = subprocess.check_output([str(binary)], text=True).splitlines()
js = ROOT / 'js/gen/tables.js'
program = "const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');import('data:text/javascript;base64,'+Buffer.from(s).toString('base64')).then(m=>process.stdout.write(JSON.stringify(m)))"
actual = json.loads(subprocess.check_output(['node', '-e', program, str(js)], text=True))
flat = []
for kind, name, count in arrays:
    assert len(actual[name]) == int(count), name
    flat.extend(str(value) for value in actual[name])
assert flat == expected, 'Generated tables differ from C compiler output'
print(f'{len(arrays)} tables, {len(flat)} values identical to compiled C')
