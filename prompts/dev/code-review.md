---
title: Code review
category: dev
tags: [review, quality]
description: Review a change for bugs first, then readability.
scope: team
variables:
  - name: focus
    description: What to pay most attention to
    default: correctness and edge cases
---

Review the current changes in this repository. Focus on {{focus}}.

1. List real bugs first, each with file:line, a failing scenario and a suggested fix.
2. Then list readability or simplification issues, briefly.
3. Skip style nits that a linter would catch.
If you find nothing serious, say so plainly.
