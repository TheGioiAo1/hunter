---
name: theme-implement
description: "Implement external UI code (Claude.ai artifacts, templates, Figma exports) into project. Hybrid Tailwind + CSS Module override for conflict-free integration."
argument-hint: "<file-path> [--output <path>] [--preview]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# Theme Implement — External Code Integration

Implement external UI code (Claude.ai Artifacts, templates, Figma exports) into project, resolve CSS conflicts automatically.

## Scope

- ✅ Implement HTML/JSX code from file or clipboard
- ✅ Resolve Tailwind class conflicts (hover, shadow, colors)
- ✅ Map hardcoded colors → project CSS variables
- ❌ Do NOT use for designing new UI (use `/frontend-design`)

## Strategy: Hybrid Tailwind + CSS Module Override

**Principle: least effort**
1. KEEP Tailwind classes for layout/spacing (SAFE)
2. MAP hardcoded colors → CSS variables (RISKY)
3. EXTRACT hover/shadow/animation → CSS Module ONLY when broken (CONFLICT)
4. MERGE with `cn()` utility

## Arguments

| Flag | Action |
|------|--------|
| `<file-path>` | Integrate from file (HTML/JSX/TSX) |
| `--output <path>` | Output folder (default: next to source file or user choice) |
| `--preview` | Only classify classes, no code generation — use for review first |

## Workflow

```
1. Read input file
2. Read project's globals.css → extract CSS variables available
3. Parse JSX/HTML structure
4. Classify Tailwind classes per element (see references/class-classification.md)
5. RISKY classes → replace inline with CSS variable syntax
6. CONFLICT classes → extract to .module.css
7. Generate output:
   - component.tsx (Tailwind safe + cn(styles.xxx) for conflicts)
   - component.module.css (ONLY if CONFLICT classes exist)
8. Compile check
```

## Rules

- **ALWAYS** read `globals.css` BEFORE integrating — need to know which CSS variables are available
- **NEVER** create `.module.css` if there are no CONFLICT classes — avoid unnecessary files
- **ALWAYS** use `cn()` from `@/lib/utils` to merge Tailwind + CSS Module classes
- **KEEP** layout Tailwind classes as-is (flex, grid, p-*, m-*, gap-*)
- **PREFER** shadcn components if external code uses similar components (Button → shadcn Button)
- **PRESERVE** original structure/layout — only fix styling conflicts, do not redesign

## Class Classification Quick Reference

See `references/class-classification.md` for full list.

| Category | Examples | Action |
|----------|----------|--------|
| **SAFE** | `flex`, `grid`, `p-4`, `gap-2`, `rounded-lg`, `text-xl` | Keep as-is |
| **RISKY** | `bg-blue-500`, `text-red-600`, `border-green-300` | Map → CSS var |
| **CONFLICT** | `hover:bg-blue-600`, `shadow-lg`, `animate-pulse` | CSS Module override |

## Output Pattern

```tsx
// component.tsx
import styles from './component.module.css';
import { cn } from '@/lib/utils';

export function IntegratedComponent() {
  return (
    <div className={cn('flex flex-col gap-4 p-8', styles.wrapper)}>
      <button className={cn('px-6 py-3 rounded-lg font-medium', styles.cta)}>
        Get Started
      </button>
    </div>
  );
}
```

```css
/* component.module.css — ONLY override conflicts */
.wrapper {
  background: var(--background);
}

.cta {
  background: var(--primary);
  color: var(--primary-foreground);
}

.cta:hover {
  background: color-mix(in oklch, var(--primary) 85%, black);
  transform: translateY(-1px);
}
```

## CSS Variable Mapping

When replacing RISKY colors, map to nearest semantic variable:

| Tailwind Class | CSS Variable |
|---------------|-------------|
| `bg-white`, `bg-gray-50` | `var(--background)` |
| `bg-gray-900`, `bg-black` | `var(--foreground)` |
| `bg-blue-*`, `bg-indigo-*` | `var(--primary)` |
| `bg-red-*` | `var(--destructive)` |
| `bg-gray-100`, `bg-slate-100` | `var(--muted)` |
| `bg-gray-200` | `var(--accent)` |
| `text-white` | `var(--primary-foreground)` |
| `text-gray-500`, `text-gray-400` | `var(--muted-foreground)` |
| `border-gray-200` | `var(--border)` |
| `ring-blue-*` | `var(--ring)` |

## Scope Boundaries

- **This skill** = integrate existing external code into project, resolve CSS conflicts
- **`/frontend-design`** = create new UI from scratch or from screenshots/videos (dispatches `designer` agent for research)
- **`designer` agent** = design research & briefs only, no code output

If the user asks to "design something new", redirect to `/frontend-design`. This skill only handles code that already exists elsewhere.

## Delegates To

- `frontend-design` → design decisions, visual quality
- `reviewer` → post-integration code review
