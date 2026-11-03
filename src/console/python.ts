/** The interpreter the account domain's python scripts run on: an explicit override, the project venv, or bare python3. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** EASEL_PYTHON wins (non-standard installs); else the venv beside the skill library (four up from its scripts dir);
 *  else the PATH's python3, which carries none of the skills' third-party imports. */
export function pythonBin(scriptsDir: string): string {
  const override = process.env.EASEL_PYTHON
  if (override !== undefined && override !== '') return override
  const venv = join(scriptsDir, '..', '..', '..', '..', '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}
