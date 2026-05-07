# CSS Module Override Patterns

Common patterns for extracting CONFLICT Tailwind classes to CSS Modules.

## Basic Override Structure

```tsx
// component.tsx
import styles from './component.module.css';
import { cn } from '@/lib/utils';

<element className={cn('safe-tailwind-classes', styles.conflictClass)} />
```

```css
/* component.module.css */
.conflictClass {
  /* only conflict overrides here */
}
```

## Pattern 1: Hover Color Override

**Before (conflict):**
```tsx
<button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg">
```

**After (resolved):**
```tsx
<button className={cn('px-4 py-2 rounded-lg font-medium', styles.btn)}>
```

```css
.btn {
  background: var(--primary);
  color: var(--primary-foreground);
}

.btn:hover {
  background: color-mix(in oklch, var(--primary) 85%, black);
}
```

## Pattern 2: Box Shadow Override

**Before:**
```tsx
<div className="shadow-lg hover:shadow-xl transition-shadow">
```

**After:**
```tsx
<div className={cn('transition-shadow', styles.card)}>
```

```css
.card {
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1);
}

.card:hover {
  box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1);
}
```

## Pattern 3: Gradient Override

**Before:**
```tsx
<div className="bg-gradient-to-r from-blue-600 to-purple-600">
```

**After:**
```tsx
<div className={styles.gradient}>
```

```css
.gradient {
  background: linear-gradient(to right, var(--primary), var(--accent));
}
```

## Pattern 4: Focus Ring Override

**Before:**
```tsx
<input className="focus:ring-2 focus:ring-blue-500 focus:border-blue-500 border rounded-md px-3 py-2">
```

**After:**
```tsx
<input className={cn('border rounded-md px-3 py-2', styles.input)}>
```

```css
.input {
  border-color: var(--border);
}

.input:focus {
  outline: none;
  box-shadow: 0 0 0 2px var(--ring);
  border-color: var(--primary);
}
```

## Pattern 5: Animation Override

**Before:**
```tsx
<div className="animate-pulse bg-gray-200">
```

**After:**
```tsx
<div className={styles.skeleton}>
```

```css
.skeleton {
  background: var(--muted);
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

## Pattern 6: Group Hover

**Before:**
```tsx
<div className="group">
  <span className="group-hover:text-blue-600">Text</span>
</div>
```

**After:**
```tsx
<div className={styles.group}>
  <span className={styles.groupText}>Text</span>
</div>
```

```css
.groupText {
  color: var(--muted-foreground);
}

.group:hover .groupText {
  color: var(--primary);
}
```

## Pattern 7: Transform on Hover

**Before:**
```tsx
<button className="hover:scale-105 hover:-translate-y-1 transition-transform">
```

**After:**
```tsx
<button className={cn('transition-transform', styles.liftBtn)}>
```

```css
.liftBtn:hover {
  transform: scale(1.05) translateY(-0.25rem);
}
```

## Useful CSS Variable Tricks

### Color with opacity
```css
/* If --primary is hsl format */
.element {
  background: hsl(var(--primary) / 0.5);
}

/* Universal approach */
.element {
  background: color-mix(in oklch, var(--primary) 50%, transparent);
}
```

### Hover darken/lighten
```css
/* Darken */
.btn:hover {
  background: color-mix(in oklch, var(--primary) 85%, black);
}

/* Lighten */
.btn:hover {
  background: color-mix(in oklch, var(--primary) 85%, white);
}
```

### Shadows with theme color
```css
.card {
  box-shadow: 0 4px 14px color-mix(in oklch, var(--primary) 30%, transparent);
}
```
