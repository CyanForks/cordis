import { Context, Service } from '@cordisjs/core'
import { Dict, isNullable } from 'cosmokit'
import { ModuleLoader } from './internal.ts'
import { Entry, EntryOptions, EntryUpdateMeta } from './config/entry.ts'
import { LoaderFile } from './config/file.ts'
import { ImportTree } from './config/import.ts'
import * as inject from './config/inject.ts'
import * as isolate from './config/isolate.ts'

export * from './config/entry.ts'
export * from './config/file.ts'
export * from './config/group.ts'
export * from './config/import.ts'
export * from './config/tree.ts'

declare module '@cordisjs/core' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/config-update'(): void
    'loader/entry-init'(entry: Entry): void
    'loader/entry-fork'(entry: Entry, type: string): void
    'loader/entry-check'(entry: Entry): boolean | undefined
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    'loader/before-patch'(this: EntryUpdateMeta, entry: Entry): void
    'loader/after-patch'(this: EntryUpdateMeta, entry: Entry): void
  }

  interface Context {
    baseDir: string
    loader: Loader<this>
  }

  interface EnvData {
    startTime?: number
  }

  interface EffectScope<C extends Context> {
    entry?: Entry<C>
  }
}

export namespace Loader {
  export interface Config {
    name: string
    initial?: Omit<EntryOptions, 'id'>[]
    filename?: string
  }
}

export abstract class Loader<C extends Context = Context> extends ImportTree<C> {
  // process
  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public params = {
    env: process.env,
  }

  public files: Dict<LoaderFile> = Object.create(null)
  public delims: Dict<symbol> = Object.create(null)
  public internal?: ModuleLoader

  constructor(public ctx: C, public config: Loader.Config) {
    super(ctx)

    ctx.set('loader', this)

    ctx.on('internal/update', (fork) => {
      if (!fork.entry) return
      fork.parent.emit('loader/entry-fork', fork.entry, 'reload')
    })

    ctx.on('internal/before-update', (scope, config) => {
      if (!scope.entry) return
      if (scope.entry.suspend) return scope.entry.suspend = false
      const schema = scope.runtime?.schema
      scope.entry.options.config = schema ? schema.simplify(config) : config
      scope.entry.parent.tree.write()
    })

    ctx.on('internal/plugin', (scope) => {
      // 1. set `fork.entry`
      if (scope.parent[Entry.key]) {
        scope.entry = scope.parent[Entry.key]
        delete scope.parent[Entry.key]
      }

      // 2. handle self-dispose
      // We only care about `ctx.scope.dispose()`, so we need to filter out other cases.

      // case 1: fork is created
      if (scope.uid) return

      // case 2: fork is not tracked by loader
      if (!scope.entry) return

      // case 3: fork is disposed on behalf of plugin deletion (such as plugin hmr)
      // self-dispose: ctx.scope.dispose() -> fork / runtime dispose -> delete(plugin)
      // plugin hmr: delete(plugin) -> runtime dispose -> fork dispose
      if (!ctx.registry.has(scope.runtime?.plugin!)) return

      scope.entry.fork = undefined
      scope.parent.emit('loader/entry-fork', scope.entry, 'unload')

      // case 4: fork is disposed by loader behavior
      // such as inject checker, config file update, ancestor group disable
      if (!scope.entry._check()) return

      scope.entry.options.disabled = true
      scope.entry.parent.tree.write()
    })

    ctx.plugin(inject)
    ctx.plugin(isolate)
  }

  async [Service.setup]() {
    await this.init(process.cwd(), this.config)
    this.ctx.set('env', process.env)
    await super[Service.setup]()
  }

  locate(ctx = this.ctx) {
    let scope = ctx.scope
    while (1) {
      if (scope.entry) return scope.entry.id
      const next = scope.parent.scope
      if (scope === next) return
      scope = next
    }
  }

  exit() {}

  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
}

export default Loader
