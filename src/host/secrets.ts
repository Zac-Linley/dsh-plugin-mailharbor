import { spawnSync } from 'node:child_process'

export type SecretProvider = 'macos' | 'libsecret' | 'windows' | 'none'

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface SecretStoreOptions {
  platform?: NodeJS.Platform
  run?: (command: string, args: string[], options?: { input?: string; timeout?: number }) => CommandResult
  hasCommand?: (command: string, args: string[]) => boolean
}

function defaultRun(
  command: string,
  args: string[],
  options: { input?: string; timeout?: number } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    input: options.input,
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function defaultHasCommand(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { timeout: 3000, stdio: 'ignore' })
  return result.error === undefined && result.status === 0
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Cross-platform secret persistence.
 *
 * macOS uses the Keychain (`security`), Linux uses libsecret (`secret-tool`),
 * Windows uses the Credential Locker through PowerShell. When no provider is
 * available the store reports unavailable; callers keep the password in this
 * process's session and never write it to the config.
 */
export class SecretStore {
  readonly provider: SecretProvider
  private readonly run: NonNullable<SecretStoreOptions['run']>
  private readonly hasCommand: NonNullable<SecretStoreOptions['hasCommand']>

  constructor(options: SecretStoreOptions = {}) {
    const platform = options.platform ?? process.platform
    this.run = options.run ?? defaultRun
    this.hasCommand = options.hasCommand ?? defaultHasCommand
    if (platform === 'darwin') {
      this.provider = 'macos'
    } else if (platform === 'win32') {
      this.provider = this.hasCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'exit 0',
      ])
        ? 'windows'
        : 'none'
    } else if (platform === 'linux') {
      this.provider = this.hasCommand('secret-tool', ['--version']) ? 'libsecret' : 'none'
    } else {
      this.provider = 'none'
    }
  }

  available(): boolean {
    return this.provider !== 'none'
  }

  read(service: string, account: string): string | undefined {
    if (service === '' || account === '') return undefined
    if (this.provider === 'macos') {
      const result = this.run('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
      if (!result.ok) return undefined
      return trimSecret(result.stdout)
    }
    if (this.provider === 'libsecret') {
      const result = this.run('secret-tool', ['lookup', 'service', service, 'account', account])
      if (!result.ok) return undefined
      return trimSecret(result.stdout)
    }
    if (this.provider === 'windows') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null',
        '$vault = New-Object Windows.Security.Credentials.PasswordVault',
        `$resource = ${psString(service)}`,
        `$user = ${psString(account)}`,
        '$cred = $vault.FindAllByResource($resource) | Where-Object { $_.UserName -eq $user } | Select-Object -First 1',
        'if ($null -eq $cred) { exit 1 }',
        '$cred.RetrievePassword()',
        '[Console]::Out.Write($cred.Password)',
      ].join('\n')
      const result = this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        input: script,
      })
      if (!result.ok) return undefined
      return trimSecret(result.stdout)
    }
    return undefined
  }

  write(service: string, account: string, secret: string): boolean {
    if (service === '' || account === '' || secret === '') return false
    if (this.provider === 'macos') {
      return this.run('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret])
        .ok
    }
    if (this.provider === 'libsecret') {
      return this.run('secret-tool', ['store', '--label', service, 'service', service, 'account', account], {
        input: secret,
      }).ok
    }
    if (this.provider === 'windows') {
      const encoded = Buffer.from(secret, 'utf8').toString('base64')
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null',
        '$vault = New-Object Windows.Security.Credentials.PasswordVault',
        `$resource = ${psString(service)}`,
        `$user = ${psString(account)}`,
        `$password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
        '$vault.FindAllByResource($resource) | Where-Object { $_.UserName -eq $user } | ForEach-Object { $vault.Remove($_) }',
        '$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($resource, $user, $password)))',
      ].join('\n')
      return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        input: script,
      }).ok
    }
    return false
  }

  delete(service: string, account: string): boolean {
    if (service === '' || account === '') return false
    if (this.provider === 'macos') {
      return this.run('security', ['delete-generic-password', '-s', service, '-a', account]).ok
    }
    if (this.provider === 'libsecret') {
      return this.run('secret-tool', ['clear', 'service', service, 'account', account]).ok
    }
    if (this.provider === 'windows') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null',
        '$vault = New-Object Windows.Security.Credentials.PasswordVault',
        `$resource = ${psString(service)}`,
        `$user = ${psString(account)}`,
        '$vault.FindAllByResource($resource) | Where-Object { $_.UserName -eq $user } | ForEach-Object { $vault.Remove($_) }',
      ].join('\n')
      return this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        input: script,
      }).ok
    }
    return false
  }
}

function trimSecret(value: string): string | undefined {
  const text = value.replace(/\r?\n$/, '')
  return text === '' ? undefined : text
}
