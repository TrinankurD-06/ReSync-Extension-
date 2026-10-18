---
title: Launch plan (chain)
category: startup
tags: [chain, launch, marketing]
description: Positioning, then channels, then a one-week launch calendar.
scope: team
chain:
  type: planning
  successCriteria: true
variables:
  - name: product
    description: One line about the product
steps:
  - text: "Write positioning for this product: {{product}}. Give the target user, the problem, and a one-sentence pitch."
    waitFor: response
    delaySeconds: 0
  - text: Based on that positioning, pick the 3 launch channels most likely to work for us and explain why in one line each.
    waitFor: timer
    delaySeconds: 20
  - text: Turn this into a 7-day launch calendar as a table with day, channel, action and owner.
    waitFor: timer
    delaySeconds: 20
---
