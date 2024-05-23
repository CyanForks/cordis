import { Context, ForkScope, Inject } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import Loader from './shared.ts'
import { EntryGroup } from './group.ts'

export namespace Entry {
  export interface Options {
    id: string
    name: string
    config?: any
    disabled?: boolean | null
    intercept?: Dict | null
    isolate?: Dict<true | string> | null
    inject?: string[] | Inject | null
    when?: any
  }
}

function swap<T extends {}>(target: T, source?: T | null) {
  for (const key of Reflect.ownKeys(target)) {
    Reflect.deleteProperty(target, key)
  }
  for (const key of Reflect.ownKeys(source || {})) {
    Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(source!, key)!)
  }
}

function takeEntries(object: {}, keys: string[]) {
  const result: [string, any][] = []
  for (const key of keys) {
    if (!(key in object)) continue
    result.push([key, object[key]])
    delete object[key]
  }
  return result
}

function sortKeys<T extends {}>(object: T, prepend = ['id', 'name'], append = ['config']): T {
  const part1 = takeEntries(object, prepend)
  const part2 = takeEntries(object, append)
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b))
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]))
}

export class Entry {
  static key = Symbol('cordis.entry')

  public fork?: ForkScope
  public isUpdate = false
  public options!: Entry.Options
  public children?: EntryGroup

  constructor(public loader: Loader, public parent: EntryGroup) {}

  unlink() {
    const config = this.parent.config
    const index = config.indexOf(this.options)
    if (index >= 0) config.splice(index, 1)
  }

  resolveRealm(label: string | true) {
    if (label === true) {
      return '#' + this.options.id
    } else {
      return '@' + label
    }
  }

  patch(ctx: Context, ref: Context = ctx) {
    ctx[Context.inject] = this.options.inject

    // part 1: prepare isolate map
    const newMap: Dict<symbol> = Object.create(Object.getPrototypeOf(ref[Context.isolate]))
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      const realm = this.resolveRealm(label)
      newMap[key] = (this.loader.realms[realm] ??= Object.create(null))[key] ??= Symbol(`${key}${realm}`)
    }

    // part 2: generate service diff
    const diff: [string, symbol, symbol, symbol, symbol][] = []
    const oldMap = ctx[Context.isolate]
    for (const key in { ...oldMap, ...newMap, ...this.loader.delims }) {
      if (newMap[key] === oldMap[key]) continue
      const delim = this.loader.delims[key] ??= Symbol(key)
      ctx[delim] = Symbol(`${key}#${this.options.id}`)
      for (const symbol of [oldMap[key], newMap[key]]) {
        const value = symbol && ctx[symbol]
        if (!(value instanceof Object)) continue
        const source = Reflect.getOwnPropertyDescriptor(value, Context.origin)?.value
        if (!source) {
          ctx.emit('internal/warning', new Error(`expected service ${key} to be implemented`))
          continue
        }
        diff.push([key, oldMap[key], newMap[key], ctx[delim], source[delim]])
        if (ctx[delim] !== source[delim]) break
      }
    }

    // part 3: emit service events
    // part 3.1: internal/before-service
    for (const [key, symbol1, symbol2, flag1, flag2] of diff) {
      const self = Object.create(null)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[this.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/before-service', key)
    }

    // part 3.2: update service impl
    if (ctx === ref) {
      swap(ctx[Context.isolate], newMap)
      swap(ctx[Context.intercept], this.options.intercept)
      // prevent double update
      this.fork?.update(this.options.config)
    } else {
      // handle entry transfer
      Object.setPrototypeOf(ctx, Object.getPrototypeOf(ref))
      swap(ctx, ref)
    }
    for (const [, symbol1, symbol2, flag1, flag2] of diff) {
      if (flag1 === flag2 && ctx[symbol1] && !ctx[symbol2]) {
        ctx.root[symbol2] = ctx.root[symbol1]
        delete ctx.root[symbol1]
      }
    }

    // part 3.3: internal/service
    for (const [key, symbol1, symbol2, flag1, flag2] of diff) {
      const self = Object.create(null)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[this.loader.delims[key]]) !== (flag1 === flag2)
      }
      ctx.emit(self, 'internal/service', key)
    }

    // part 4: clean up delimiter
    for (const key in this.loader.delims) {
      if (!Reflect.ownKeys(newMap).includes(key)) {
        delete ctx[this.loader.delims[key]]
      }
    }
  }

  createContext() {
    return this.parent.ctx.extend({
      [Context.intercept]: Object.create(this.parent.ctx[Context.intercept]),
      [Context.isolate]: Object.create(this.parent.ctx[Context.isolate]),
    })
  }

  async update(options: Entry.Options) {
    const legacy = this.options
    this.options = sortKeys(options)
    if (!this.loader.isTruthyLike(options.when) || options.disabled) {
      this.stop()
    } else if (this.fork) {
      this.isUpdate = true
      for (const [key, label] of Object.entries(legacy.isolate ?? {})) {
        if (this.options.isolate?.[key] === label) continue
        const name = this.resolveRealm(label)
        this.loader._clearRealm(key, name)
      }
      this.patch(this.fork.parent)
    } else {
      const plugin = await this.loader.resolve(this.options.name)
      if (!plugin) return
      const ctx = this.createContext()
      this.patch(ctx)
      ctx[Entry.key] = this
      this.fork = ctx.plugin(plugin, this.options.config)
      ctx.emit('loader/entry', 'apply', this)
    }
  }

  stop() {
    this.fork?.dispose()
    this.fork = undefined

    // realm garbage collection
    for (const [key, label] of Object.entries(this.options.isolate ?? {})) {
      const name = this.resolveRealm(label)
      this.loader._clearRealm(key, name)
    }
  }
}
