#!/usr/bin/env python3
"""Bundle the app into one self-contained HTML file (used for the claude.ai preview).

Usage: python3 scripts/build-single-file.py OUT.html [ESBUILD]
Needs esbuild (pass its path, or have it on PATH). No service worker or manifest:
the single file is for previewing, not installing.
"""
import os, re, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1]
esbuild = sys.argv[2] if len(sys.argv) > 2 else 'esbuild'

with tempfile.TemporaryDirectory() as tmp:
    bundle = os.path.join(tmp, 'bundle.js')
    subprocess.run([esbuild, os.path.join(root, 'js/app.js'), '--bundle', '--format=iife', '--target=es2020',
                    f'--outfile={bundle}', '--log-level=warning'], check=True)
    app = open(bundle).read()

html = open(os.path.join(root, 'index.html')).read()
css = open(os.path.join(root, 'css/app.css')).read()
vex = open(os.path.join(root, 'js/vendor/vexflow.js')).read()
for src in (vex, app):
    assert '</script' not in src.lower()

head = re.search(r'<head>(.*?)</head>', html, re.S).group(1)
body = re.search(r'<body>(.*?)</body>', html, re.S).group(1)
head = re.sub(r'\s*<meta[^>]*>', '', head)
head = re.sub(r'\s*<link rel="(manifest|icon|apple-touch-icon)"[^>]*>', '', head)
page = head.strip() + '\n' + body
page = page.replace('<link rel="stylesheet" href="css/app.css">', '<style>\n' + css + '\n</style>')
page = page.replace('<script src="js/vendor/vexflow.js"></script>', '<script>\n' + vex + '\n</script>')
page = page.replace('<script type="module" src="js/app.js"></script>', '<script>\n' + app + '\n</script>')
open(out, 'w').write(page)
print(f'wrote {out} ({len(page) // 1024} KB)')
