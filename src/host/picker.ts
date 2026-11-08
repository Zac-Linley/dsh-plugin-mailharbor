import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function electronDialog(defaultPath?: string): Promise<string | null | undefined> {
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as {
      dialog?: {
        showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>
      }
    }
    if (electron.dialog === undefined) return undefined
    const result = await electron.dialog.showOpenDialog({
      title: '选择项目目录',
      ...(defaultPath === undefined ? {} : { defaultPath }),
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  } catch {
    return undefined
  }
}

/**
 * Native directory picker for the desktop app.
 *
 * Tries Electron's dialog first (the Host runs inside the desktop main
 * process), then the platform's own dialog. Returns null when the user
 * cancels and throws when no picker is available.
 */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  const electron = await electronDialog(defaultPath)
  if (electron !== undefined) return electron

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run(
        'osascript',
        ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")'],
        { timeout: 180_000 },
      )
      const path = stdout.trim()
      return path === '' ? null : path.replace(/\/$/, '')
    } catch {
      // Cancel exits non-zero; treat it as "no selection".
      return null
    }
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "选择项目目录"',
      'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }',
    ].join('; ')
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], { timeout: 180_000 })
      return stdout.trim() === '' ? null : stdout.trim()
    } catch {
      return null
    }
  }

  try {
    const { stdout } = await run('zenity', ['--file-selection', '--directory', '--title=选择项目目录'], {
      timeout: 180_000,
    })
    return stdout.trim() === '' ? null : stdout.trim()
  } catch {
    throw new Error('当前环境无法打开目录选择器，请手动输入路径')
  }
}

export async function openPath(path: string): Promise<void> {
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as { shell?: { openPath(target: string): Promise<string> } }
    if (electron.shell !== undefined) {
      const error = await electron.shell.openPath(path)
      if (error !== '') throw new Error(error)
      return
    }
  } catch {
    // Fall through to the platform opener.
  }
  if (process.platform === 'darwin') {
    await run('open', [path])
    return
  }
  if (process.platform === 'win32') {
    await run('explorer', [path])
    return
  }
  await run('xdg-open', [path])
}
