# Slidango template

Warm paper, bold Geist headlines with one italic punchline, a single tango accent. Calm, precise, a little elegant.

## Writing rules

- **Headlines:** short statements, not topics. Put exactly one punchline in italics: `# Slides, made *together.*` The italic part turns into Instrument Serif in tango. Never two italic parts, never mid-word.
- **Bullets:** three to five per slide, each at most one line. Start with the point, not with filler.
- **Eyebrow:** optional `eyebrow:` in the frontmatter adds a small label above the content (e.g. `Q4 · Platform`).
- **Speaker notes:** put them in an HTML comment at the end of the slide: `<!-- … -->`.
- **Code:** fenced code blocks render dark on the paper slide. Keep them short.
- No emojis, no exclamation marks, no superlatives.

## Layouts

### cover
Title slide on a dot grid. `#` title (with one italic punchline), one sentence below. Optional `eyebrow`, `author`, `date`.

```md
---
layout: cover
eyebrow: Platform team · Q4
author: Gabriel Lipnik
date: November 2026
---

# Q4 Platform *Review*

Where we are, and what ships next.
```

### default
Headline and content, page number at the bottom. Optional `eyebrow`.

```md
---
eyebrow: Q4 · Platform
---

# Where we *are*

- Migration finished in October
- Three of five teams onboarded
- Support tickets down by a third
```

### section
Opens a chapter: tango rule on the left, big headline, one line below. `eyebrow` replaces the automatic page number label.

```md
---
layout: section
eyebrow: Part 2
---

# What ships *next*

Four things for the first quarter.
```

### two-cols
Two columns. Content before `::right::` goes left, after it right. Optional `::top::` for a headline across both.

```md
---
layout: two-cols
---

::top::
# Before and *after*

::default::
- Manual onboarding
- Two weeks per team

::right::
- Self-service
- One afternoon per team
```

### center
Everything centered. Good for a single question or a short list.

### statement
One big sentence, centered, with one italic punchline. Optional line below.

```md
---
layout: statement
---

# Fewer tickets, *happier* teams.
```

### fact
A number that matters. The `#` is the number (rendered huge in tango serif), the paragraph explains it.

```md
---
layout: fact
---

# −34 %

Support tickets since the migration.
```

### quote
A quote in large serif italics, the source below in mono.

```md
---
layout: quote
---

“Decks are team work.”

Gabriel Lipnik, Platform team
```

### end
Closing slide on the dot grid with the mark. `#` and an optional line.

```md
---
layout: end
---

# Questions?

slides.example.com
```
