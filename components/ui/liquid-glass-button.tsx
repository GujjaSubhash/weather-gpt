'use client'

/*
 * Glass and metal buttons, adapted from a third-party shadcn-style drop-in.
 *
 * Three deliberate departures from the source, all forced by this project:
 *
 * 1. The generic `Button` + `buttonVariants` are NOT ported. They were the only
 *    consumer of `@radix-ui/react-slot`, which is not installed here (this repo's
 *    shadcn flavour is base-nova/@base-ui/react), so that file could not even
 *    bundle. Nothing here needed them.
 * 2. Every shadcn colour token is replaced with a literal. globals.css defines no
 *    --primary / --ring / --destructive, so `text-primary`, `ring-ring/50` and
 *    friends compiled to nothing at all.
 * 3. `dark:` prefixes are dropped in favour of the dark value. Tailwind v4's
 *    built-in `dark` variant keys off the OS preference, but this app is
 *    unconditionally dark via hardcoded CSS — so a visitor on a light-mode OS
 *    would have got the light-mode treatment on a #0a0a0a page.
 */

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const liquidbuttonVariants = cva(
  cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap',
    'rounded-md text-sm font-medium outline-none',
    'transition-colors transition-[color,box-shadow]',
    'disabled:pointer-events-none disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    // Literal focus ring — ring-ring/50 was a dead token.
    'focus-visible:border-white/70 focus-visible:ring-[3px] focus-visible:ring-white/50'
  ),
  {
    variants: {
      variant: {
        default: 'bg-transparent text-inherit transition duration-300 hover:scale-105',
        outline: 'border border-white/20 bg-white/5 hover:bg-white/10',
        secondary: 'bg-white/10 text-white hover:bg-white/20',
        ghost: 'hover:bg-white/10',
      },
      size: {
        // The `has-[>svg]:*` padding overrides the source shipped here are
        // deliberately gone. GlassFilter renders an <svg> as a direct child, so
        // `:has(> svg)` was ALWAYS true, and those rules then beat any plain
        // px-* override on specificity — making the size prop unfixable from the
        // outside. Plain padding only.
        sm: 'h-8 gap-1.5 px-4 text-xs',
        default: 'h-9 px-4 py-2',
        lg: 'h-10 rounded-md px-6',
        xl: 'h-12 rounded-md px-8',
        xxl: 'h-14 rounded-md px-10',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export type LiquidButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof liquidbuttonVariants>

/**
 * Glass button: a shadow stack that reads as a bevelled lens, over a
 * backdrop-filtered layer.
 *
 * The `url(#…)` displacement is progressive enhancement — only Chromium honours
 * a filter reference in `backdrop-filter`. It is paired with a plain `blur()`
 * so Safari and Firefox still get glass rather than a transparent hole.
 */
function LiquidButton({ className, variant, size, children, ...props }: LiquidButtonProps) {
  return (
    <button
      data-slot="button"
      className={cn('relative', liquidbuttonVariants({ variant, size, className }))}
      {...props}
    >
      <div
        className={cn(
          'absolute top-0 left-0 z-0 h-full w-full rounded-full transition-all',
          'shadow-[0_0_8px_rgba(0,0,0,0.03),0_2px_6px_rgba(0,0,0,0.08),inset_3px_3px_0.5px_-3.5px_rgba(255,255,255,0.09),inset_-3px_-3px_0.5px_-3.5px_rgba(255,255,255,0.85),inset_1px_1px_1px_-0.5px_rgba(255,255,255,0.6),inset_-1px_-1px_1px_-0.5px_rgba(255,255,255,0.6),inset_0_0_6px_6px_rgba(255,255,255,0.12),inset_0_0_2px_2px_rgba(255,255,255,0.06),0_0_12px_rgba(0,0,0,0.15)]'
        )}
      />
      <div
        className="absolute top-0 left-0 isolate -z-10 h-full w-full overflow-hidden rounded-md"
        style={{ backdropFilter: 'blur(3px) url("#weathergpt-container-glass")' }}
      />
      <div className="pointer-events-none z-10 inline-flex items-center gap-2">{children}</div>
    </button>
  )
}

/**
 * The SVG filter LiquidButton's backdrop references.
 *
 * Render this ONCE per document, not per button — the source nested it inside
 * every button, so two buttons meant two elements sharing id="container-glass".
 * Keeping it out of the button also keeps `:has(> svg)` false, which is what
 * makes the size variants overridable at all.
 */
export function GlassFilter() {
  return (
    <svg className="hidden" aria-hidden="true">
      <defs>
        <filter
          id="weathergpt-container-glass"
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.05 0.05"
            numOctaves="1"
            seed="1"
            result="turbulence"
          />
          <feGaussianBlur in="turbulence" stdDeviation="2" result="blurredNoise" />
          {/* Modest scale: the source's 70 samples far outside a filter region
              clipped to the element box, which smears small controls. */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="blurredNoise"
            scale="12"
            xChannelSelector="R"
            yChannelSelector="B"
            result="displaced"
          />
          <feGaussianBlur in="displaced" stdDeviation="1" result="finalBlur" />
          <feComposite in="finalBlur" in2="finalBlur" operator="over" />
        </filter>
      </defs>
    </svg>
  )
}

type ColorVariant = 'default' | 'success' | 'error' | 'gold' | 'bronze'

interface MetalButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ColorVariant
}

// The source's "primary" variant is dropped: its gradients were built from
// from-primary / via-secondary / to-muted, all undefined here, so it rendered
// with no background at all. Every variant below is hex literals.
const colorVariants: Record<
  ColorVariant,
  { outer: string; inner: string; button: string; textColor: string; textShadow: string }
> = {
  default: {
    outer: 'bg-linear-to-b from-[#000] to-[#A0A0A0]',
    inner: 'bg-linear-to-b from-[#FAFAFA] via-[#3E3E3E] to-[#E5E5E5]',
    button: 'bg-linear-to-b from-[#B9B9B9] to-[#969696]',
    textColor: 'text-white',
    textShadow: '[text-shadow:_0_-1px_0_rgb(80_80_80_/_100%)]',
  },
  success: {
    outer: 'bg-linear-to-b from-[#005A43] to-[#7CCB9B]',
    inner: 'bg-linear-to-b from-[#E5F8F0] via-[#00352F] to-[#D1F0E6]',
    button: 'bg-linear-to-b from-[#9ADBC8] to-[#3E8F7C]',
    textColor: 'text-[#FFF7F0]',
    textShadow: '[text-shadow:_0_-1px_0_rgb(6_78_59_/_100%)]',
  },
  error: {
    outer: 'bg-linear-to-b from-[#5A0000] to-[#FFAEB0]',
    inner: 'bg-linear-to-b from-[#FFDEDE] via-[#680002] to-[#FFE9E9]',
    button: 'bg-linear-to-b from-[#F08D8F] to-[#A45253]',
    textColor: 'text-[#FFF7F0]',
    textShadow: '[text-shadow:_0_-1px_0_rgb(146_64_14_/_100%)]',
  },
  gold: {
    outer: 'bg-linear-to-b from-[#917100] to-[#EAD98F]',
    inner: 'bg-linear-to-b from-[#FFFDDD] via-[#856807] to-[#FFF1B3]',
    button: 'bg-linear-to-b from-[#FFEBA1] to-[#9B873F]',
    textColor: 'text-[#FFFDE5]',
    textShadow: '[text-shadow:_0_-1px_0_rgb(178_140_2_/_100%)]',
  },
  bronze: {
    outer: 'bg-linear-to-b from-[#864813] to-[#E9B486]',
    inner: 'bg-linear-to-b from-[#EDC5A1] via-[#5F2D01] to-[#FFDEC1]',
    button: 'bg-linear-to-b from-[#FFE3C9] to-[#A36F3D]',
    textColor: 'text-[#FFF7F0]',
    textShadow: '[text-shadow:_0_-1px_0_rgb(124_45_18_/_100%)]',
  },
}

const metalButtonVariants = (
  variant: ColorVariant = 'default',
  isPressed: boolean,
  isHovered: boolean,
  isTouchDevice: boolean
) => {
  const colors = colorVariants[variant]
  const transitionStyle = 'all 250ms cubic-bezier(0.1, 0.4, 0.2, 1)'

  return {
    wrapper: cn(
      'relative inline-flex transform-gpu rounded-md p-[1.25px] will-change-transform',
      colors.outer
    ),
    wrapperStyle: {
      transform: isPressed ? 'translateY(2.5px) scale(0.99)' : 'translateY(0) scale(1)',
      boxShadow: isPressed
        ? '0 1px 2px rgba(0, 0, 0, 0.15)'
        : isHovered && !isTouchDevice
          ? '0 4px 12px rgba(0, 0, 0, 0.12)'
          : '0 3px 8px rgba(0, 0, 0, 0.08)',
      transition: transitionStyle,
      transformOrigin: 'center center',
    },
    inner: cn(
      'absolute inset-[1px] transform-gpu rounded-lg will-change-transform',
      colors.inner
    ),
    innerStyle: {
      transition: transitionStyle,
      transformOrigin: 'center center',
      filter: isHovered && !isPressed && !isTouchDevice ? 'brightness(1.05)' : 'none',
    },
    button: cn(
      'relative z-10 m-[1px] inline-flex h-11 transform-gpu cursor-pointer items-center justify-center gap-2',
      'overflow-hidden rounded-md px-6 py-2 text-sm leading-none font-semibold',
      'will-change-transform outline-none',
      // The source gave `disabled` no visual treatment whatsoever. Without this
      // a disabled send button looks identical to an enabled one.
      'disabled:cursor-default disabled:opacity-45',
      colors.button,
      colors.textColor,
      colors.textShadow
    ),
    buttonStyle: {
      transform: isPressed ? 'scale(0.97)' : 'scale(1)',
      transition: transitionStyle,
      transformOrigin: 'center center',
      filter: isHovered && !isPressed && !isTouchDevice ? 'brightness(1.02)' : 'none',
    },
  }
}

const ShineEffect = ({ isPressed }: { isPressed: boolean }) => (
  <div
    className={cn(
      'pointer-events-none absolute inset-0 z-20 overflow-hidden transition-opacity duration-300',
      isPressed ? 'opacity-20' : 'opacity-0'
    )}
  >
    <div className="absolute inset-0 rounded-md bg-linear-to-r from-transparent via-neutral-100 to-transparent" />
  </div>
)

/**
 * Brushed-metal button with press and hover states.
 *
 * Geometry (h-11, px-6) can be overridden through `className` — tailwind-merge
 * resolves it because the class list is passed through `cn` last.
 */
export const MetalButton = React.forwardRef<HTMLButtonElement, MetalButtonProps>(
  ({ children, className, variant = 'default', disabled, ...props }, ref) => {
    const [isPressed, setIsPressed] = React.useState(false)
    const [isHovered, setIsHovered] = React.useState(false)
    const [isTouchDevice, setIsTouchDevice] = React.useState(false)

    React.useEffect(() => {
      setIsTouchDevice('ontouchstart' in window || navigator.maxTouchPoints > 0)
    }, [])

    const variants = metalButtonVariants(variant, isPressed, isHovered, isTouchDevice)

    // A disabled control must not look pressed or hovered — it can't be either.
    const press = (next: boolean) => {
      if (!disabled) setIsPressed(next)
    }

    return (
      <div className={variants.wrapper} style={variants.wrapperStyle}>
        <div className={variants.inner} style={variants.innerStyle} />
        <button
          ref={ref}
          disabled={disabled}
          className={cn(variants.button, className)}
          style={variants.buttonStyle}
          {...props}
          onMouseDown={() => press(true)}
          onMouseUp={() => press(false)}
          onMouseEnter={() => {
            if (!isTouchDevice && !disabled) setIsHovered(true)
          }}
          onMouseLeave={() => {
            press(false)
            setIsHovered(false)
          }}
          onTouchStart={() => press(true)}
          onTouchEnd={() => press(false)}
          onTouchCancel={() => press(false)}
        >
          <ShineEffect isPressed={isPressed} />
          {children}
          {isHovered && !isPressed && !isTouchDevice && (
            <div className="pointer-events-none absolute inset-0 rounded-lg bg-linear-to-t from-transparent to-white/5" />
          )}
        </button>
      </div>
    )
  }
)

MetalButton.displayName = 'MetalButton'

export { LiquidButton, liquidbuttonVariants }
