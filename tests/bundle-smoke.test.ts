import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { resolveTakeoverGatewayCompat } from '../src/compat/gateway/resolve.js'
import {
  isCustomOpenAiGateway,
  resolveTakeoverProviders,
  takeoverProvidersOf,
} from '../src/compat/gateway/takeover.js'

const root = resolve(import.meta.dirname, '..')

type Descriptor = {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => ClientPlugin
}

type ClientPlugin = {
  readonly name: string
  readonly inject: readonly string[]
  readonly apply: (context: ClientContext) => void
}

type ClientContext = {
  get(name: string): unknown
  plugin(plugin: { inject?: readonly string[]; apply: (scope: ClientContext) => void }): unknown
  inject(names: string[], callback: (scope: ClientContext) => void): unknown
  on(event: 'internal/service', callback: (name: string) => void): unknown
  effect(callback: () => void | (() => void), label?: string): unknown
}

function readArtifact(relativePath: string): string {
  try {
    return readFileSync(resolve(root, relativePath), 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Missing ${relativePath}; run npm run build first. ${detail}`)
  }
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }
  return packageJson.version
}

/**
 * Read one CSS Modules rule out of the built client bundle by its local class
 * name, whatever hash the bundler gave it.
 *
 * The seat's styling is only observable there: the source names classes
 * `scale`/`tick`/`modelMenu`, and the bundle has already resolved them. jsdom
 * performs no layout, so a rule cannot be *measured* from a test — but pinning
 * its shape still earns its place, because every assertion below guards a
 * defect that was actually reproduced in a browser first, and each one states
 * the measurement it rests on. What it does not do is survive a re-minified
 * property order or a renamed rule without a real regression behind it.
 */
function cssRule(bundle: string, local: string): string {
  const match = new RegExp(`\\.[A-Za-z0-9_-]+_${local}\\{[^}]*\\}`).exec(bundle)
  expect(match, `${local} rule missing from the bundle`).not.toBeNull()
  return match![0]
}

/**
 * The same, for a pseudo-element rule. lightningcss folds `::before` down to a
 * single colon, while the vendor ones keep both — so the two are read through
 * separate helpers rather than through one flag.
 */
function cssBefore(bundle: string, local: string): string {
  const match = new RegExp(`\\.[A-Za-z0-9_-]+_${local}:before\\{[^}]*\\}`).exec(bundle)
  expect(match, `${local}:before rule missing from the bundle`).not.toBeNull()
  return match![0]
}

function cssVendorPseudo(bundle: string, local: string, pseudo: string): string {
  const match = new RegExp(`\\.[A-Za-z0-9_-]+_${local}::${pseudo}\\{[^}]*\\}`).exec(bundle)
  expect(match, `${local}::${pseudo} rule missing from the bundle`).not.toBeNull()
  return match![0]
}

/**
 * The same, for a selector that is not a class. The seat's shared geometry
 * tokens live on the document root — both cards are portaled to `body`, so a
 * declaration on `.root` would read as undefined inside them.
 */
function cssGlobalRule(bundle: string, selector: string): string {
  const match = new RegExp(`${selector}\\{[^}]*\\}`).exec(bundle)
  expect(match, `${selector} rule missing from the bundle`).not.toBeNull()
  return match![0]
}

function loadDescriptor(source: string): Descriptor {
  let descriptor: Descriptor | undefined
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value: Descriptor) {
          descriptor = value
        },
      },
    },
  })
  if (descriptor === undefined) throw new Error('Client bundle did not register a descriptor')
  return descriptor
}

function createReactPlatform(): Record<string, unknown> {
  return {
    createElement: () => ({}),
    Fragment: Symbol.for('react.fragment'),
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: (value: () => unknown) => value(),
    useState: (value: unknown) => [value, () => undefined],
  }
}

function createReactDomPlatform(): Record<string, unknown> {
  return { createPortal: (node: unknown) => node }
}

describe('build artifacts', () => {
  it('emits and executes the lazy client descriptor contract', () => {
    const source = readArtifact('lib/client.js')
    expect(source).toContain('window.__ModuleLoader__.load')
    expect(source).toContain("id: '@hytime/dsh-thinking-effort'")
    expect(source).toContain(JSON.stringify(readPackageVersion()))
    expect(source).toContain('return module.exports;')
    expect(source).not.toContain("ctx.inject(['remote',")

    const descriptor = loadDescriptor(source)
    const required: string[] = []
    const React = createReactPlatform()
    const factory = descriptor.factory((specifier) => {
      required.push(specifier)
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
      if (specifier === 'react-dom') return createReactDomPlatform()
      throw new Error(`Unexpected external dependency: ${specifier}`)
    })

    expect(descriptor.id).toBe('@hytime/dsh-thinking-effort')
    expect(factory.name).toBe('@hytime/dsh-thinking-effort')
    expect(factory.inject).toEqual(['slots', 'connection', 'locale'])
    expect(typeof factory.apply).toBe('function')
    expect(required).toContain('react')
    expect(required).toContain('react/jsx-runtime')
    expect(required).toContain('react-dom')
  })

  it('reads remote.settings through get and subscribes to service availability', () => {
    const descriptor = loadDescriptor(readArtifact('lib/client.js'))
    const React = createReactPlatform()
    const plugin = descriptor.factory((specifier) => {
      if (specifier === 'react') return React
      if (specifier === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
      if (specifier === 'react-dom') return createReactDomPlatform()
      throw new Error(`Unexpected external dependency: ${specifier}`)
    })

    let remoteReads = 0
    const remoteSettings = { describe: async () => ({ ok: true }), mutate: async () => ({ ok: true }) }
    const context: ClientContext = {
      get(name) {
        if (name === 'slots') {
          return {
            inject: (_slot: string, callback: () => void) => callback(),
            register: () => undefined,
          }
        }
        if (name === 'connection') return undefined
        if (name === 'locale') {
          return {
            register: () => () => undefined,
            bind: () => (key: string) => key,
            getSnapshot: () => ({ locales: [] }),
          }
        }
        if (name === 'remote.settings') {
          remoteReads += 1
          return remoteSettings
        }
        // Optional host model-directory service (ui-model-selection): the
        // composer seat probes it once and skips itself when it is absent —
        // this profile has no such service.
        if (name === 'modelDirectories') return undefined
        // Older DSH transports expose no `remote.session` (the seat's modern
        // session remote shape); a profile without it registers the base list.
        if (name === 'remote.session') return undefined
        if (name === 'remote') return undefined
        throw new Error(`Unexpected context read: ${name}`)
      },
      on(event, callback) {
        expect(event).toBe('internal/service')
        expect(callback).toBeTypeOf('function')
        return () => undefined
      },
      plugin(plugin: { inject?: readonly string[]; apply: (scope: ClientContext) => void }) {
        const allPresent = (plugin.inject ?? []).every((name) => context.get(name) !== undefined)
        if (allPresent) plugin.apply(context)
        return () => undefined
      },
      inject(names: string[], callback: (scope: ClientContext) => void) {
        // Legacy compatibility path retained for older client plugins. The
        // current seat uses the named plugin fiber above.
        const allPresent = names.every((name) => context.get(name) !== undefined)
        if (allPresent) callback(context)
        return () => undefined
      },
      effect(callback) {
        callback()
      },
    }

    plugin.apply(context)
    expect(remoteReads).toBe(1)
  })

  it('projects shared pi-ai provider and model compat with precedence without takeover', () => {
    const piAi = {
      providers: {
        local: {
          api: 'openai-completions',
          baseURL: 'http://gateway.test/v1',
          compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
          models: [{
            id: 'model',
            reasoningEfforts: { off: null, high: 'high' },
            compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false },
          }],
         },
       },
    }
    const overridePiAi = {
      providers: {
        local: {
          api: 'openai-completions',
          baseURL: 'http://gateway.test/v1',
          compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
          modelOverrides: {
            override: {
              reasoningEfforts: { high: 'high' },
              compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
            },
          },
        },
      },
    }

    expect(resolveTakeoverProviders({ version: '0.1.1-rc.2', piAi })).toEqual(['local'])
    expect(resolveTakeoverProviders({ version: '0.1.0-rc.7', piAi })).toEqual([])
    expect(resolveTakeoverGatewayCompat({
      version: '0.1.1-rc.2',
      piAi,
      provider: 'local',
      model: 'model',
    })).toMatchObject({
      thinkingFormat: { value: 'qwen', source: 'model' },
      supportsReasoningEffort: { value: false, source: 'model' },
    })
    expect(resolveTakeoverGatewayCompat({
      version: '0.1.1-rc.2',
      piAi: overridePiAi,
      provider: 'local',
      model: 'override',
    })).toMatchObject({
      thinkingFormat: { value: 'openai', source: 'model' },
      supportsReasoningEffort: { value: true, source: 'model' },
    })
    expect(resolveTakeoverGatewayCompat({
      version: '0.1.1-rc.2',
      piAi: overridePiAi,
      provider: 'local',
      model: 'missing',
    })).toMatchObject({
      thinkingFormat: { value: 'deepseek', source: 'provider' },
      supportsReasoningEffort: { value: true, source: 'provider' },
    })
    expect(resolveTakeoverGatewayCompat({
      version: '0.1.1-rc.2',
      piAi,
      provider: 'local',
      model: 'model',
      takeover: { enabled: true, providers: ['other'] },
    })).toBeUndefined()
    expect(takeoverProvidersOf(undefined)).toBeNull()
  })

  it('requires a non-official endpoint in addition to the completions api', () => {
    expect(isCustomOpenAiGateway({ api: 'openai-completions', baseURL: 'https://api.openai.com/v1' })).toBe(false)
    expect(isCustomOpenAiGateway({ api: 'openai-completions' })).toBe(false)
    expect(isCustomOpenAiGateway({ api: 'openai-completions', baseURL: 'https://gateway.test/v1' })).toBe(true)
  })

  it('reads an enabled takeover list without mutating its fields', () => {
    const section = { enabled: true, providers: ['local'] }
    expect(takeoverProvidersOf(section)).toEqual(['local'])
    expect(section).toEqual({ enabled: true, providers: ['local'] })
  })

  it('exports the Host entry contract', async () => {
    readArtifact('lib/index.js')
    const host = await import(`${pathToFileURL(resolve(root, 'lib/index.js')).href}?smoke=${Date.now()}`)

    expect(host).toHaveProperty('name')
    expect(host).toHaveProperty('inject')
    expect(host).toHaveProperty('apply')
  })
})

describe('composer seat surface material', () => {
  /**
   * The seat's panel and model list are portaled cards painted by a real
   * `.material` child, the way the official MenuSurface does it. The child is
   * what makes the frosted material work: a `::before` pseudo sized to the
   * padding box, so rows scrolled past it lost their background entirely.
   *
   * The translucent fill is only correct together with the blur that backs it,
   * so the pair must survive the build together, and the `@supports` fallback
   * must stay opaque for engines without `backdrop-filter`. Asserted on the
   * built artifact because these are build-time token substitutions.
   *
   * The CSS-Modules hash is build-dependent, and lightningcss hashes are not
   * purely alphanumeric — the released 0.3.3 bundle contains `._3_LLuW_panel`,
   * where the hash itself starts with an underscore. The class is therefore
   * matched as `.<hash>_<local>` with a character class that admits `_` and
   * `-`, so the assertion does not depend on which environment produced the
   * hash.
   */
  it('paints the panel and menu with a real material layer, not a bare translucent fill', () => {
    const bundle = readArtifact('lib/client.js')

    // Guard the matcher itself: lightningcss produced `._3_LLuW_panel` in the
    // released 0.3.3 bundle, so a hash beginning with `_` must match. Without
    // this, a matcher that only accepted alphanumerics would pass here on a
    // build whose hash happens to be alphanumeric and fail in CI.
    expect(new RegExp('\\.[A-Za-z0-9_-]+_panel\\{[^}]*\\}').test('._3_LLuW_panel{isolation:isolate}')).toBe(true)

    // Each card establishes its own backdrop root and carries no fill of its
    // own; the `.material` child behind the content owns the painting. The
    // filter cannot live on the card itself: backdrop-filter also makes the
    // element a containing block for fixed-position descendants, and the model
    // menu is a second fixed card portalled alongside this one.
    for (const local of ['panel', 'modelMenu'] as const) {
      const rule = cssRule(bundle, local)
      expect(rule, `${local} must isolate its own backdrop root`).toContain('isolation:isolate')
      expect(rule, `${local} must not paint a fill over its own material child`).not.toContain('background:')
    }

    // Opaque where there is no blur to back a translucent fill...
    expect(cssRule(bundle, 'material')).toContain('background:var(--dsw-alias-bg-layer-2)')
    // ...and frosted, with the blur that makes the fill readable, where there is.
    expect(bundle).toContain('backdrop-filter:var(--dsw-menu-backdrop-filter)')
    expect(bundle).toContain('var(--dsw-menu-surface-fill)')

    // The defect from issue #14: a bare `--dsw-specific-menu` with no blur
    // behind it. This stylesheet must never reference it at all.
    expect(bundle).not.toContain('--dsw-specific-menu')
  })
})

describe('composer seat affordances', () => {
  /**
   * The scale labels are absolutely positioned by the same fractions the pips
   * use, and the model row's chevron has an open state that turns it over. Both
   * are pure CSS consequences of class names the component toggles, so they are
   * asserted on the built artifact where the class hash is already resolved.
   */
  it('centers the scale labels on the pips and flips the open chevron', () => {
    const bundle = readArtifact('lib/client.js')

    // An evenly divided flex label sat half a step inside each end pip.
    // lightningcss folds translateX into the two-value translate shorthand.
    expect(cssRule(bundle, 'tick')).toContain('transform:translate(-50%)')
    expect(cssRule(bundle, 'tick')).not.toContain('flex:')
    expect(cssRule(bundle, 'scale')).toContain('position:relative')

    // A pip only sits half a thumb (9px) in from the panel's content edge, and
    // "Max" is about 12px half its width, so centring the end labels there ran
    // them 3.2px past the content box — and no layout-side change helps: the
    // panel's padding cancels out of that comparison, and the label would have
    // to drop to 9.6px to fit. Each end label is instead anchored by the edge
    // that faces outward, and set on the outer edge of its own pip rather than
    // the pip's centre. `:not()` keeps a single-label scale from being anchored
    // sideways at all.
    const firstTick = new RegExp(`\\.[A-Za-z0-9_-]+_tick:first-child:not\\(:last-child\\)\\{[^}]*\\}`).exec(bundle)
    const lastTick = new RegExp(`\\.[A-Za-z0-9_-]+_tick:last-child:not\\(:first-child\\)\\{[^}]*\\}`).exec(bundle)
    expect(firstTick, 'end-label anchor rule missing from the bundle').not.toBeNull()
    expect(lastTick, 'end-label anchor rule missing from the bundle').not.toBeNull()
    expect(firstTick![0]).toContain('text-align:left')
    expect(lastTick![0]).toContain('text-align:right')
    // A `calc()` argument stops lightningcss folding these into `translate`.
    expect(firstTick![0]).toContain('transform:translateX(calc(-1 * var(--te-pip-half)))')
    expect(lastTick![0]).toContain('transform:translateX(calc(-100% + var(--te-pip-half)))')
    // The offset is half a pip, and the pip is 14px: the 2:1 ratio is what makes
    // a label read as belonging to a dot rather than to a point.
    expect(cssGlobalRule(bundle, ':root')).toContain('--te-pip-half:7px')
    expect(cssRule(bundle, 'rangePip')).toContain('width:14px')

    // 45deg points down-right, 225deg is the same arrow turned back up. The
    // model row's arrow is a ::before on a bordered box, and lightningcss
    // emits it as a single-colon `:before` with the function list minified.
    expect(cssBefore(bundle, 'chevron')).toContain('transform:rotate(45deg)translateY(-2px)')
    expect(cssBefore(bundle, 'chevronOpen')).toContain('transform:rotate(225deg)translateY(-2px)')

    // The group heading draws its own L out of borders rather than a ::before,
    // so it is a separate rule — and its two states translate opposite ways.
    // The glyph is asymmetric, so rotating it 180deg puts its point on the
    // other side of the box centre; translating both the same way would push
    // the two states 2.9px further apart rather than aligning them.
    expect(cssRule(bundle, 'modelGroupChevron')).toContain('transform:rotate(45deg)translateY(-2px)')
    expect(cssRule(bundle, 'modelGroupChevronOpen')).toContain('transform:rotate(225deg)translateY(2px)')
    // Held at its own width. The label beside it ellipsises, but the row still
    // absorbs the difference and the glyph is what gives without this floor —
    // measured, an ellipsised label left the 8.5px box at 7.05px.
    // lightningcss normalises `flex: 0 0 auto` to the equivalent `flex: none`.
    expect(cssRule(bundle, 'modelGroupChevron')).toContain('flex:none')
  })

  /**
   * A native range keeps the thumb's whole box inside the track, so its centre
   * travels only [half a thumb, width - half a thumb] — a full thumb shorter
   * than the track. The track, the fill and the scale are inset by half a thumb
   * so their ends sit where the centre actually reaches.
   *
   * Pixel-measured in a real browser at 320px: before, the centre read
   * -3.5 / 97.5 / 197.5 / 298.5 against pips at 0 / 106.66 / 213.33 / 320; after,
   * 9 / 109.5 / 209.5 / 310 against pips at 9 / 109.66 / 210.33 / 311. A
   * negative margin cannot fix this — it shifts both ends at once — so the
   * assertion below is that the inset exists and the margin does not.
   */
  it('insets the track so its ends meet the thumb centre travel', () => {
    const bundle = readArtifact('lib/client.js')

    // Half of the 18px thumb Chromium actually renders (range thumbs are
    // border-box, so the 3px borders are inside that width). Declared on the
    // document root, not the seat root: the panel is portaled to `body`, and a
    // token declared on `.root` resolves to nothing inside it — which would
    // silently drop the inset at runtime while every rule still reads correctly
    // in the built artifact.
    expect(cssGlobalRule(bundle, ':root')).toContain('--te-thumb-inset:9px')

    const track = cssRule(bundle, 'rangeTrack')
    expect(track).toContain('left:var(--te-thumb-inset)')
    expect(track).toContain('right:var(--te-thumb-inset)')
    expect(track).not.toContain('left:0;')

    // The labels are absolutely positioned, so they resolve their `left: N%`
    // against the containing block's padding box — which, with no border, is
    // this element's border box. A padding here would not move them at all and
    // the two rows would run on different fractions (312px against the track's
    // 294px, measured, leaving every label 2-3px off its pip). Only a margin
    // shrinks the box the percentages are taken against.
    expect(cssRule(bundle, 'scale')).toContain('margin:0 var(--te-thumb-inset)')
    expect(cssRule(bundle, 'scale')).not.toContain('padding:0 var(--te-thumb-inset)')

    expect(cssVendorPseudo(bundle, 'range', '-webkit-slider-thumb')).not.toContain('margin-left')
    expect(cssVendorPseudo(bundle, 'range', '-moz-range-thumb')).not.toContain('margin-left')
  })

  /**
   * The official MenuSurface rounds every floating surface to
   * `--dsw-radius-lg` (16px), and the scale is xs 4 / sm 8 / md 12 / lg 16 /
   * xl 20 / panel 28. The seat carried a hardcoded 8px on the panel and 6px on
   * the model menu, and 6px is not a value in the scale at all.
   */
  it('rounds both floating surfaces with the host radius token', () => {
    const bundle = readArtifact('lib/client.js')

    for (const local of ['panel', 'modelMenu'] as const) {
      const rule = cssRule(bundle, local)
      expect(rule, `${local} must use the host radius token`).toContain('border-radius:var(--dsw-radius-lg)')
      expect(rule, `${local} must not hardcode a radius`).not.toMatch(/border-radius:\d/)
    }
  })

  /**
   * The official model menu paints its group title with the surface fill, sets
   * the menu's scrollbar tokens, and keeps the title stuck while the list
   * scrolls. A heading that is only translucent would let the options
   * underneath show through it.
   */
  it('sticks the provider heading and gives the menu the host scrollbar', () => {
    const bundle = readArtifact('lib/client.js')

    // Scrolling moved to the inner viewport — an absolutely positioned child of
    // a scroller scrolls away with the content, so the material layer has to
    // hang off the card instead. The scrollbar tokens and the reserved gutter
    // therefore belong to the viewport, and the card itself no longer scrolls.
    const viewport = cssRule(bundle, 'modelMenuViewport')
    expect(viewport).toContain('--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)')
    expect(viewport).toContain('--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)')
    // A classic scrollbar takes layout width, so expanding a provider used to
    // narrow the content box and shift every row's chevron left.
    expect(viewport).toContain('scrollbar-gutter:stable')
    expect(cssRule(bundle, 'modelMenu')).toContain('overflow:hidden')

    const heading = cssRule(bundle, 'modelGroupToggle')
    expect(heading).toContain('position:sticky')
    // The scrollport carries no padding, and the card's own pad plus its
    // overflow clip the strip above it, so `top: 0` already lands the heading
    // on the menu's inner edge and the leading pad is the official 4px.
    expect(heading).toContain('top:0')
    expect(heading).toContain('padding:4px 7px 2px')
    // The label is one line by construction, so the row is sized by its padding
    // alone (26px, measured) and carries no min-height of its own.
    expect(heading).not.toContain('min-height')
    expect(cssRule(bundle, 'modelMenu')).toContain('padding:var(--te-menu-pad)')
    expect(cssGlobalRule(bundle, ':root')).toContain('--te-menu-pad:4px')
    // A translucent fill alone still lets the scrolled options read through it,
    // which is the defect issue #14 was about in a new place. The heading
    // therefore carries the same material as the card — fill *and* blur.
    expect(heading).toContain('background:var(--dsw-menu-surface-fill)')
    expect(heading).toContain('backdrop-filter:var(--dsw-menu-backdrop-filter)')
    expect(heading).not.toContain('background:transparent')
    // The official group title runs 11px on 16px.
    expect(heading).toContain('line-height:16px')
  })

  /**
   * `--dsw-alias-interactive-bg-hover` is `#ffffff14` in the dark theme — 8%
   * white, fully translucent. Assigning it to the `background` shorthand
   * replaced the stuck heading's fill outright, so hovering it made the
   * heading see-through and the options underneath showed over it. The token
   * has to be layered on top of the fill instead.
   */
  it('keeps the stuck heading opaque on hover', () => {
    const bundle = readArtifact('lib/client.js')
    const match = /modelGroupToggle:hover[^{]*\{[^}]*\}/.exec(bundle)
    expect(match, 'the hover rule missing from the bundle').not.toBeNull()
    const rule = match![0]

    expect(rule).toContain('background-color:var(--dsw-menu-surface-fill)')
    expect(rule).toContain('background-image:linear-gradient(var(--dsw-alias-interactive-bg-hover)')
    // The shorthand would drop the material background-color again.
    expect(rule).not.toMatch(/(^|;)\s*background:\s*var\(--dsw-alias-interactive-bg-hover\)/)
  })

  /**
   * The remaining drift from the host's own model menu: the panel pads by
   * 12px like the official composer surface, the heading runs at weight 500,
   * and the option is a border-box flex row centred by height rather than
   * pushed down by padding.
   */
  it('matches the host menu metrics that do not fight this seat layout', () => {
    const bundle = readArtifact('lib/client.js')

    const panel = cssRule(bundle, 'panel')
    expect(panel).toContain('padding:var(--te-panel-pad)')
    expect(cssGlobalRule(bundle, ':root')).toContain('--te-panel-pad:12px')

    // The menu is a second fixed card placed from the model row's rect, so it
    // no longer resolves its insets against the panel's padding box and takes a
    // width of its own. Only the viewport half of a height cap means anything:
    // the placement pass already clamps it to the space that is left, and the
    // 220px ceiling is this seat's own, not the host's 360px.
    const menu = cssRule(bundle, 'modelMenu')
    expect(menu).toContain('position:fixed')
    expect(menu).toContain('width:min(304px,100vw - 24px)')
    expect(menu).toContain('max-height:min(220px,100vh - 24px)')
    expect(menu).not.toMatch(/[^-](min|max)-width:/)

    const heading = cssRule(bundle, 'modelGroupToggle')
    expect(heading).toContain('font-weight:500')

    // The card is a flex column capped at 220px, so every child is shrinkable
    // by default and the search box lost 12 of its 32px to the list below it —
    // measured 20px in a browser. Only the viewport is meant to absorb the
    // height difference.
    expect(cssRule(bundle, 'modelSearch')).toContain('flex:none')
    expect(cssRule(bundle, 'modelMenuViewport')).toContain('min-height:0')

    const option = cssRule(bundle, 'modelOption')
    expect(option).toContain('align-items:center')
    expect(option).toContain('padding:0 8px')
    // No `box-sizing` needed: a button is border-box in the UA sheet already,
    // and with horizontal padding only it makes no difference to the 34px row.
    expect(option).not.toContain('box-sizing')
  })

  /**
   * The panel reads the host's content type scale, so it tracks the Settings
   * font-size preference the way the composer and the chat do. The fallbacks
   * reproduce the previous fixed 13px/20px exactly, so nothing moves at the
   * default 14px body.
   */
  it('takes the panel type scale from the host content scale', () => {
    const bundle = readArtifact('lib/client.js')

    // The panel itself, not the seat root: it is portaled to `body`, so a scale
    // declared on `.root` can no longer reach it and the card would silently
    // fall back to the body's 14px.
    const panel = cssRule(bundle, 'panel')
    expect(panel).toContain('font-size:var(--dsh-content-font-size-secondary,13px)')
    expect(panel).toContain('line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))')
    // A fixed size here is what made the panel ignore the preference.
    expect(panel).not.toMatch(/font-size:13px/)
    expect(panel).not.toMatch(/line-height:20px/)
    expect(cssRule(bundle, 'root')).not.toContain('font-size')
    // The label row is absolutely positioned, so it has to be told how tall it
    // is, and that height has to grow with the same scale.
    expect(cssRule(bundle, 'scale')).toContain('height:calc(20px + var(--dsh-content-font-delta-secondary,0px))')
  })
})
