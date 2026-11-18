#!/usr/bin/env python3
"""
Port legacy per-page inline <style> blocks into a page-scoped CSS file.

- Extracts every <style> block from a legacy page in document order.
- Drops the three shared shell blocks (already in src/styles/shell.css).
- Scopes selectors under `.pg-<name>` so per-page theme overrides (e.g. the
  dashboard "Nebula Grid" :root/body layer) cannot leak across routes.
  `:root` / `html` / `body` selectors are rewritten to the page root element.
- Leaves @keyframes / @font-face / @import untouched.

Usage: port-legacy-css.py <legacy_html> <page-name> <out.css>
"""
import re, sys, hashlib

SHARED = {'55466e76', 'ee3c44d9', '7e436912'}
src, name, out = sys.argv[1:4]
html = open(src, encoding='utf-8').read()
blocks = re.findall(r'<style[^>]*>(.*?)</style>', html, re.S)
scope = f'.pg-{name}'

def scope_selector(sel: str) -> str:
    sel = sel.strip()
    if not sel:
        return sel
    if sel in (':root', 'html', 'body', 'html, body', 'html,body'):
        return scope
    if sel.startswith('body:before') or sel.startswith('body::before'):
        return sel.replace('body', scope, 1)
    if sel.startswith('body:after') or sel.startswith('body::after'):
        return sel.replace('body', scope, 1)
    m = re.match(r'^(html\[[^\]]+\]|html\.[\w-]+|\[dir=[^\]]+\]|html)\s+(.*)$', sel)
    if m:
        return f'{m.group(1)} {scope} {m.group(2)}'
    if sel.startswith('body '):
        return scope + sel[4:]
    if sel.startswith('body.'):
        return scope + sel[4:]
    if sel.startswith('*'):
        return f'{scope} {sel}'
    return f'{scope} {sel}'

def scope_rule_list(css: str) -> str:
    out_parts = []
    i = 0
    n = len(css)
    while i < n:
        # skip whitespace/comments
        m = re.match(r'\s*/\*.*?\*/\s*', css[i:], re.S)
        if m and m.end() > 0 and css[i:i+m.end()].strip().startswith('/*'):
            out_parts.append(css[i:i+m.end()]); i += m.end(); continue
        if css[i].isspace():
            out_parts.append(css[i]); i += 1; continue
        if css[i] == '@':
            # at-rule
            j = css.find('{', i)
            semi = css.find(';', i)
            if j == -1 or (semi != -1 and semi < j):
                # @import/@charset ...;
                end = semi + 1 if semi != -1 else n
                out_parts.append(css[i:end]); i = end; continue
            head = css[i:j]
            # find matching brace
            depth = 0; k = j
            while k < n:
                if css[k] == '{': depth += 1
                elif css[k] == '}':
                    depth -= 1
                    if depth == 0: break
                k += 1
            body = css[j+1:k]
            if re.match(r'@(media|supports|layer|container)', head.strip()):
                out_parts.append(head + '{' + scope_rule_list(body) + '}')
            else:
                out_parts.append(head + '{' + body + '}')
            i = k + 1; continue
        # normal rule
        j = css.find('{', i)
        if j == -1:
            out_parts.append(css[i:]); break
        selectors = css[i:j]
        depth = 0; k = j
        while k < n:
            if css[k] == '{': depth += 1
            elif css[k] == '}':
                depth -= 1
                if depth == 0: break
            k += 1
        body = css[j:k+1]
        parts = [scope_selector(s) for s in selectors.split(',')]
        out_parts.append(', '.join(p for p in parts if p) + body)
        i = k + 1
    return ''.join(out_parts)

pieces = [f'/* Ported from legacy {src.split("/legacy/")[-1]} — page-scoped under {scope}. Do not hand-edit selectors; regenerate with tools/port-legacy-css.py */\n']
for idx, b in enumerate(blocks):
    h = hashlib.md5(b.strip().encode()).hexdigest()[:8]
    if h in SHARED:
        pieces.append(f'\n/* [block {idx} {h}] shared shell CSS — see src/styles/shell.css */\n'); continue
    pieces.append(f'\n/* ---- legacy <style> block {idx} ({h}) ---- */\n')
    pieces.append(scope_rule_list(b))
open(out, 'w', encoding='utf-8').write(''.join(pieces))
print(f'{out}: {len(blocks)} blocks, wrote {sum(len(p) for p in pieces)} bytes')
