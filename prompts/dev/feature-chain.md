---
title: Build a feature in three passes
category: dev
tags: [chain, planning, tests]
description: Plan, implement, then test a feature, one step per reply.
scope: team
variables:
  - name: feature
    description: The feature to build
steps:
  - text: "Plan how to add this feature: {{feature}}. List the files you will touch and the risks. Do not write code yet."
    waitFor: response
    delaySeconds: 0
  - text: Implement the plan above. Keep the change small and match the surrounding code style.
    waitFor: response
    delaySeconds: 0
  - text: Write or update tests for what you just built, run them, and report the results.
    waitFor: timer
    delaySeconds: 30
---
