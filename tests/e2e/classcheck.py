import re,sys
css=open('css/app.css').read()
js=open('js/app.js').read()+open('index.html').read()
# collect class tokens from class="..." strings in JS (static parts only)
toks=set()
for m in re.finditer(r'class(?:Name)?="([^"]*)"',js):
    s=re.sub(r'\$\{[^}]*\}',' ',m.group(1))
    toks.update(s.split())
for m in re.finditer(r"className = '([^']*)'",js): toks.update(m.group(1).split())
for m in re.finditer(r"const (?:BTN_PRIMARY|LOGIN_BTN) = '([^']*)'",js): toks.update(m.group(1).split())
# ternary strings inside ${...}
for m in re.finditer(r"'([a-zA-Z0-9\-\[\]\/:\.\(\)%_ ]{3,})'",js):
    if ' ' in m.group(1) or '-' in m.group(1): toks.update(m.group(1).split())
def esc(t): 
    return re.sub(r'([^a-zA-Z0-9_-])',lambda m:'\\'+m.group(1),t)
missing=[]
for t in sorted(toks):
    if not re.match(r'^[a-z\-:\[\]\/0-9\.\(\)%_!]+$',t) or t.startswith('-') and False: continue
    e=esc(t)
    if ('.'+e) not in css and ('.'+e.replace('\\/','\\/')) not in css:
        missing.append(t)
print(len(toks),'tokens;missing:',missing)
