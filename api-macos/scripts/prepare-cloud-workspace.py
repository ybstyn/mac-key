from pathlib import Path
import hashlib
import json
import os
import shutil

workspace = Path(__file__).resolve().parents[2]
destination = workspace / 'mac-key-ci'
assert destination.resolve().parent == workspace.resolve() and (destination / '.git').is_dir()
excluded = {'.git', 'node_modules', 'target', 'out', 'dist', 'build', '.build', '.keys', '__pycache__', '.cache', '.venv', 'coverage', 'release', '.pnpm-store'}
binary = {'.exe', '.dll', '.node', '.pdb', '.lib', '.nupkg', '.zip', '.dmg', '.msi', '.dpapi', '.pem', '.pfx', '.p12', '.sqlite', '.sqlite-wal', '.sqlite-shm'}

def allowed(file):
    name = file.name.lower()
    return file.suffix.lower() not in binary and name not in {'.relay-master-key', 'credentials.json', 'accounts.json', 'api-keys.json', 'update-private.xml'} and not (name == '.env' or name.startswith('.env.') and 'example' not in name)

def tree(source, target):
    for folder, directories, names in os.walk(source):
        directories[:] = [name for name in directories if name not in excluded]
        for name in names:
            file = Path(folder) / name
            if not file.is_file() or not allowed(file):
                continue
            if file.stat().st_size > 40 * 1024 * 1024:
                raise RuntimeError('Unexpected large source file: ' + str(file.relative_to(workspace)))
            copy = target / file.relative_to(source)
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, copy)

tree(workspace / 'api-macos', destination / 'api-macos')
cherry = workspace / 'cherry-studio'
for folder in ['src', 'packages', 'scripts', 'migrations', 'patches', 'resources', 'tests', 'native']:
    tree(cherry / folder, destination / 'cherry-studio' / folder)
for file in cherry.iterdir():
    if file.is_file() and allowed(file) and (file.suffix in ['.json', '.yaml', '.yml', '.ts', '.cjs', '.md'] or file.name in ['LICENSE', '.npmrc', '.nvmrc', '.node-version']):
        shutil.copy2(file, destination / 'cherry-studio' / file.name)
tree(workspace / 'juhai-api-build/source/cockpit-tools-1.3.66', destination / 'native-source')
assets = destination / 'api-macos/assets'
assets.mkdir(exist_ok=True)
for source, target in [('juhai-logo.png', 'brand.png'), ('app-icon-preview.png', 'brand-icon.png'), ('openai.png', 'openai.png'), ('claude.png', 'claude.png'), ('gemini.png', 'gemini.png')]:
    shutil.copy2(workspace / 'cockpit-link/assets' / source, assets / target)
flows = destination / '.github/workflows'
flows.mkdir(parents=True, exist_ok=True)
shutil.copy2(workspace / 'api-macos/cloud-workflow.yml', flows / 'macos-build.yml')
(destination / '.gitignore').write_text('node_modules/\ntarget/\nbuild/\nout/\ndist/\nrelease/\n.env\n.env.*\n*.dpapi\n.keys/\n*.keychain\n', encoding='utf8')
shutil.copy2(workspace / 'api-macos/云端构建说明.txt', destination / '构建说明.txt')
shutil.copy2(workspace / 'api-macos/cloud-readme.md', destination / 'README.md')
files = [file for file in destination.rglob('*') if file.is_file() and '.git' not in file.relative_to(destination).parts]
report = {'files': len(files), 'bytes': sum(file.stat().st_size for file in files), 'nativeTransport': 'macOS same-user authenticated Unix socket', 'modelCalls': 0, 'macBuildExecuted': False}
(destination / 'preparation-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report))
