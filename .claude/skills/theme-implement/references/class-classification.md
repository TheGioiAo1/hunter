# Tailwind Class Classification for Integration

## SAFE — Keep as-is (no conflict)

Layout & positioning:
```
flex, inline-flex, grid, inline-grid, block, inline-block, hidden
relative, absolute, fixed, sticky
top-*, right-*, bottom-*, left-*, inset-*
float-*, clear-*
```

Spacing:
```
p-*, px-*, py-*, pt-*, pr-*, pb-*, pl-*
m-*, mx-*, my-*, mt-*, mr-*, mb-*, ml-*
gap-*, gap-x-*, gap-y-*
space-x-*, space-y-*
```

Sizing:
```
w-*, h-*, min-w-*, min-h-*, max-w-*, max-h-*
size-*
```

Flexbox & Grid:
```
flex-row, flex-col, flex-wrap, flex-nowrap
items-*, justify-*, self-*, place-*
col-span-*, row-span-*, grid-cols-*, grid-rows-*
order-*
```

Border (shape only, not color):
```
rounded-*, rounded-t-*, rounded-b-*, rounded-l-*, rounded-r-*
border, border-0, border-2, border-4, border-8
border-t, border-b, border-l, border-r
```

Typography (size/weight only, not color):
```
text-xs, text-sm, text-base, text-lg, text-xl, text-2xl...
font-thin, font-light, font-normal, font-medium, font-semibold, font-bold
leading-*, tracking-*, line-clamp-*
text-left, text-center, text-right, text-justify
uppercase, lowercase, capitalize, truncate
italic, not-italic, underline, line-through
```

Overflow & visibility:
```
overflow-*, overflow-x-*, overflow-y-*
z-*, opacity-* (static values)
visible, invisible, collapse
```

Misc:
```
cursor-*, select-*, pointer-events-*
aspect-*, object-*, whitespace-*, break-*
sr-only, not-sr-only
```

## RISKY — Map sang CSS variable

Colors (background):
```
bg-{color}-{shade}    →  bg-[var(--xxx)]
  bg-white            →  bg-[var(--background)]
  bg-black            →  bg-[var(--foreground)]
  bg-gray-50/100      →  bg-[var(--background)] or bg-[var(--muted)]
  bg-gray-200/300      →  bg-[var(--accent)]
  bg-gray-800/900      →  bg-[var(--card)]
  bg-blue/indigo-*    →  bg-[var(--primary)]
  bg-red-*            →  bg-[var(--destructive)]
  bg-green-*          →  bg-[var(--chart-2)] or custom
  bg-yellow-*         →  bg-[var(--chart-4)] or custom
```

Colors (text):
```
text-{color}-{shade}  →  text-[var(--xxx)]
  text-white          →  text-[var(--primary-foreground)]
  text-black          →  text-[var(--foreground)]
  text-gray-500/600   →  text-[var(--muted-foreground)]
  text-gray-900       →  text-[var(--foreground)]
  text-blue-*         →  text-[var(--primary)]
  text-red-*          →  text-[var(--destructive)]
```

Colors (border):
```
border-{color}-{shade} →  border-[var(--border)]
  border-gray-200/300  →  border-[var(--border)]
  border-blue-*       →  border-[var(--primary)]
  border-red-*        →  border-[var(--destructive)]
```

Colors (ring):
```
ring-{color}-{shade}  →  ring-[var(--ring)]
```

Divide:
```
divide-{color}-{shade} →  divide-[var(--border)]
```

## CONFLICT — Extract sang CSS Module

Hover states (most common conflict source):
```
hover:bg-*       →  .class:hover { background: var(--xxx); }
hover:text-*     →  .class:hover { color: var(--xxx); }
hover:shadow-*   →  .class:hover { box-shadow: ...; }
hover:scale-*    →  .class:hover { transform: scale(...); }
hover:opacity-*  →  .class:hover { opacity: ...; }
hover:-translate-y-* → .class:hover { transform: translateY(-...); }
```

Focus states:
```
focus:ring-*     →  .class:focus { box-shadow: 0 0 0 ...px var(--ring); }
focus:border-*   →  .class:focus { border-color: var(--xxx); }
focus:outline-*  →  .class:focus { outline: ...; }
focus-visible:*  →  .class:focus-visible { ... }
```

Active/group states:
```
active:bg-*      →  .class:active { ... }
active:scale-*   →  .class:active { ... }
group-hover:*    →  .group:hover .class { ... }
```

Shadows (often custom, conflict-prone):
```
shadow-sm, shadow, shadow-md, shadow-lg, shadow-xl, shadow-2xl
shadow-{color}-*
→ .class { box-shadow: ...; }
```

Gradients:
```
bg-gradient-to-*
from-{color}-{shade}
via-{color}-{shade}
to-{color}-{shade}
→ .class { background: linear-gradient(...); }
```

Animations & transitions:
```
animate-spin, animate-pulse, animate-bounce, animate-ping
transition-*, duration-*, ease-*, delay-*
→ .class { animation/transition: ...; }
```

Transforms (with states):
```
hover:scale-*, hover:rotate-*, hover:translate-*
→ .class:hover { transform: ...; }
```

## Edge Cases

### Tailwind arbitrary values `[...]`
```
bg-[#1a1a2e]     →  RISKY: map to nearest CSS var
text-[14px]       →  SAFE: keep as-is (sizing, not color)
w-[calc(100%-2rem)] → SAFE: keep as-is
```

### Dark mode prefix `dark:`
```
dark:bg-gray-900  →  SKIP: handled by CSS variables automatically
dark:text-white   →  SKIP: CSS variables handle this
```
→ Remove `dark:` prefixes entirely — CSS variables auto-adapt to dark mode.

### Responsive prefixes
```
sm:flex, md:grid-cols-2, lg:px-8  →  SAFE: keep as-is
sm:bg-blue-500                    →  RISKY: map CSS var with responsive
```
