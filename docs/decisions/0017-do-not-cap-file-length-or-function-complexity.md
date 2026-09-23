# 17. Do not cap file length or function complexity

## Status

Accepted.

## Context

The build failed a source file over 150 lines of code, a test file over 400
lines, a function with a cyclomatic complexity over 10, and nesting deeper
than 3. The caps were introduced to keep files readable. Over time they
shaped the decomposition instead: the checkpoint write path is spread across
about a dozen modules divided by processing step, several modules exist only
to hold a function the cap pushed out of its neighbour, and the cheapest way
under the cap was sometimes to document less, which is why comments were
later excluded from the count.

The coding guidelines this repository is held to say not to count lines
(rule 21), not to split highly related elements into small modules (rule 10),
and that a check which breaks the build must concern correctness rather than
style (rule 52). A line count is not a correctness property. The sibling
package held to the same guidelines has no such caps.

## Decision

We remove the `max-lines`, `complexity` and `max-depth` lint rules and the
file-length guard. A module is as large as the one decision it hides.

## Consequences

Positive. Modules can be merged back along the decisions they hide, where
a cap used to force them apart. Documentation no longer competes with code
for a budget.

Negative. Nothing mechanical now stops a file or a function from growing
without bound; review has to. A reviewer judging complexity has the
guidelines' symptoms (rule 20) to go by, not a number.

Neutral. No source changes in the same change: existing files keep their
current size until the modules are consolidated along the decisions they
hide.
