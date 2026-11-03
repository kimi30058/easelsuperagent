/** WeChat official-account credentials: the accounts.web entry of wechat-publisher.yaml, read and written through python. */
import { join } from 'node:path'
import { AccountError } from './login-runner.ts'
import { runReal, type RunCommand } from './whoami.ts'
import { pythonBin } from './python.ts'

const READ_PY = `import json,pathlib,sys,yaml
p=pathlib.Path(sys.argv[1])
d=yaml.safe_load(p.read_text(encoding='utf-8')) if p.is_file() else {}
a=(d or {}).get('accounts') or {}
w=a.get('web') or {}
print(json.dumps({'app_id':w.get('app_id') or '','app_secret':w.get('app_secret') or '','name':w.get('name') or '','author':w.get('author') or ''},ensure_ascii=False))`
const WRITE_PY = `import pathlib,sys,yaml
p=pathlib.Path(sys.argv[1])
d=yaml.safe_load(p.read_text(encoding='utf-8')) if p.is_file() else {}
d=d if isinstance(d,dict) else {}
a=d.setdefault('accounts',{})
a['web']={'app_id':sys.argv[2],'app_secret':sys.argv[3],'name':sys.argv[4],'author':sys.argv[5]}
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(yaml.safe_dump(d,allow_unicode=True,sort_keys=False),encoding='utf-8')`
const CLEAR_PY = `import pathlib,sys,yaml
p=pathlib.Path(sys.argv[1])
if p.is_file():
  d=yaml.safe_load(p.read_text(encoding='utf-8')) or {}
  (d.get('accounts') or {}).pop('web',None)
  p.write_text(yaml.safe_dump(d,allow_unicode=True,sort_keys=False),encoding='utf-8')`
const VERIFY_PY = `import json,sys,urllib.parse,urllib.request
q=urllib.parse.urlencode({'grant_type':'client_credential','appid':sys.argv[1],'secret':sys.argv[2]})
try:
  with urllib.request.urlopen('https://api.weixin.qq.com/cgi-bin/token?'+q,timeout=25) as r:
    d=json.loads(r.read().decode())
except Exception as e:
  print(json.dumps({'ok':False,'message':f'网络错误：{e}'}));raise SystemExit
print(json.dumps({'ok':'access_token' in d,'message':'' if 'access_token' in d else f"errcode={d.get('errcode')} {d.get('errmsg')}"}))`

/** The credentials view the card shows: configured plus a masked AppID — the secret never crosses back. */
export interface CredentialsView { configured: boolean; appIdMasked: string; name: string; author: string }
interface StoredAccount { app_id: string; app_secret: string; name: string; author: string }

/** accounts.web of the wechat-publisher skill's yaml, written by merging (other accounts survive) and verified against the token API. */
export class WechatCredentials {
  private readonly deps: { yamlPath: string; python: string; run: RunCommand }
  constructor(deps: { scriptsDir: string; python?: string; run?: RunCommand }) {
    const skillDir = join(deps.scriptsDir, '..', '..', 'builtin', 'skill-wechat-publisher')
    this.deps = { yamlPath: join(skillDir, 'wechat-publisher.yaml'), python: deps.python ?? pythonBin(deps.scriptsDir), run: deps.run ?? runReal }
  }
  /** The stored state as the card shows it: AppID masked, secret absent. */
  async get(): Promise<CredentialsView> {
    const account = await this.read()
    const configured = Boolean(account.app_id && account.app_secret)
    return { configured,
      appIdMasked: account.app_id.length > 10 ? `${account.app_id.slice(0, 6)}***${account.app_id.slice(-4)}` : account.app_id ? '***' : '',
      name: account.name, author: account.author }
  }
  /** Store AppID/AppSecret (validating presence), then verify against the real token endpoint; stored even when verification fails. */
  async save(appId: string, appSecret: string, name: string, author: string): Promise<{ ok: boolean; message: string }> {
    if (!appId.trim() || !appSecret.trim()) throw new AccountError(400, 'AppID 和 AppSecret 都不能为空')
    const written = await this.deps.run([this.deps.python, '-c', WRITE_PY, this.deps.yamlPath, appId.trim(), appSecret.trim(), name.trim(), author.trim()],
      { cwd: '/', timeoutMs: 15_000 })
    if (written.code !== 0) throw new AccountError(503, `凭证写入失败（python3 或 pyyaml 不可用，退出码 ${written.code}）`)
    const verification = await this.deps.run([this.deps.python, '-c', VERIFY_PY, appId.trim(), appSecret.trim()],
      { cwd: '/', timeoutMs: 30_000 })
    const parsed = parseJsonLine(verification.stdout)
    if (parsed === undefined) return { ok: false, message: '凭证已保存，但验证未能执行（python3 或网络不可用）' }
    return parsed.ok ? { ok: true, message: '公众号凭证已保存并验证通过' }
      : { ok: false, message: `凭证已保存但验证未通过：${parsed.message}。若是 40164 请把服务器出口 IP 加入公众号 IP 白名单。` }
  }
  /** Remove accounts.web (logout); a missing file or entry is already clear. */
  async clear(): Promise<void> {
    await this.deps.run([this.deps.python, '-c', CLEAR_PY, this.deps.yamlPath], { cwd: '/', timeoutMs: 15_000 }).catch(() => undefined)
  }
  /** The stored account; a read that cannot run or parse degrades to empty — the card shows "not configured", not an outage. */
  private async read(): Promise<StoredAccount> {
    try {
      const finished = await this.deps.run([this.deps.python, '-c', READ_PY, this.deps.yamlPath], { cwd: '/', timeoutMs: 15_000 })
      const parsed = parseJsonLine(finished.stdout)
      return parsed === undefined ? EMPTY_ACCOUNT : parsed as StoredAccount
    } catch { return EMPTY_ACCOUNT }
  }
}
const EMPTY_ACCOUNT: StoredAccount = { app_id: '', app_secret: '', name: '', author: '' }
const parseJsonLine = (stdout: string): { ok?: boolean; message?: string } | undefined => {
  const line = lastLine(stdout)
  if (line === '') return undefined
  try { return JSON.parse(line) as { ok?: boolean; message?: string } } catch { return undefined }
}
const lastLine = (stdout: string): string => [...stdout.split('\n')].reverse().find(line => line.trim()) ?? ''
