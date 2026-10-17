---
title: Make flashcards
category: study
tags: [learning, revision]
description: Turn material into question and answer flashcards.
scope: personal
variables:
  - name: material
  - name: count
    default: "10"
---

Make {{count}} flashcards from this material as a Markdown table with columns Question and Answer. Prefer questions that test understanding over recall.

{{material}}
