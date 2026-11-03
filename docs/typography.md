# Typography

The interface uses the shared `--text-*` scale in `app/globals.css`, aligned
with T3 Code's rem-based scale. At the default 16px root size:

| Utility | Size / line height | Role |
| --- | --- | --- |
| `text-xs` | 12 / 16px | Metadata, captions, compact controls, tool details |
| `text-sm` | 14 / 20px | Standard interface text, session names, settings labels |
| `text-base` | 16 / 24px | Body-sized interface content |
| `text-lg` | 18 / 28px | Small headings |
| `text-xl` | 20 / 28px | Headings |
| `text-2xl` | 24 / 32px | Dialog titles |
| `text-3xl` | 30 / 36px | Page titles |

Use these utilities instead of `text-[Npx]`. Rem units preserve the relationship
between interface sizes when the root font size changes. The existing interface
font preference controls `--font-ui`; code keeps the monospace family.

## Reading and editing

`lh-prose` uses the separate reading font and `--lh-prose-size` preference
(default 16px), with a 1.5 line height. `lh-input` uses the same family and size
with a 1.25 line height. The preference applies to lessons, thinking, answers,
and reading tables. It must not control settings labels or sidebar session names.

Do not combine `lh-prose` or `lh-input` with a competing size utility. These
unlayered CSS rules take precedence over Tailwind utilities; a second size class
would be misleading rather than effective.

Graph-canvas labels retain their graph-specific size settings and world/screen
coordinate behavior. Mermaid retains its explicit base size and existing cap
relative to the reading text. These renderers do not use CSS utility font sizes.

## Verification

After `npm run build`, `LH_TEST_PRODUCTION=1 node scripts/smoke-appearance.mjs`
checks computed typography in real lesson,
reveal-card, sidebar and settings components, reading-size changes and persistence,
root-size scaling, and layout at 1440, 640 and 390px widths using isolated data.
Set `LH_TEST_SCREENSHOTS` to a directory to save the checked screens.
