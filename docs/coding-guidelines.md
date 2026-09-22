# Coding Guidelines

Reference. Each entry is one instruction. Examples illustrate; they do not argue.
The reasoning is not on this page.

---

## 1. Decomposition

1. Do not decompose along the flowchart. Begin from a list of the design decisions that are difficult or likely to change, and design one module per decision to hide it from the others.
2. Treat a module as a work assignment, not as a step in the processing. Design decisions outlast execution order, so modules do not correspond to steps.
3. State, for every module, the one decision it hides.
4. Choose the interface so it reveals as little as possible about the inner workings.
5. Expect the decomposition, not the number of modules, to determine whether the system can be changed. Judge a decomposition by asking which likely changes stay inside one module.
6. Keep interfaces free of shared data formats. An interface that is a format is a design decision two teams must agree on and cannot change alone.
7. Accept that hiding a decision behind calls has a run-time cost, and pay it deliberately. Where the cost is real, keep the module boundary and change how the calls are assembled, not the boundary.

*Example: for a system that reads lines, shifts them and sorts them, the decomposition that gives each step a module forces every module to change when line storage changes. The decomposition that gives line storage its own module confines that change to one place.*

## 2. Module depth

8. Make interfaces much simpler than implementations. Interface complexity is the cost; functionality is the benefit.
9. Ask of every module: is it deep? Reject it when the interface is wide relative to what it hides.
10. Do not split highly related elements into separate small modules. Small means little information hidden, which means implementation complexity leaks to callers, which means callers break when the implementation changes.
11. Design the interface for the general case. Allowing the edge case is a main reason interfaces become complicated.
12. Change an interface by addition only, wherever possible.
13. Treat an abstraction that omits important details as a false abstraction, not a simplification.

*Example of depth: the Unix file interface — `open`, `read`, `write`, `close`, `lseek` — has not changed while its implementation was rewritten for decades.*
*Example of the opposite: needing `FileInputStream`, `BufferedInputStream` and `ObjectInputStream` to read a file, where forgetting the middle one silently costs buffering.*

## 3. Layers

14. Give each layer a different abstraction. A layer that passes its caller's abstraction through unchanged is removed.
15. Record the permitted import direction between layers in a file the tooling reads, and fail the build on a violation.
16. Isolate complexity where it is rarely touched. Complexity that nobody has to interact with is close to complexity removed.

## 4. Complexity

17. Treat complexity as anything that makes the software hard to understand or to modify. Obscurity and dependencies cause it: dependency is when code cannot be understood in isolation; obscurity is when important information is not obvious.
18. Take the reader's verdict, not the writer's. If other people find a piece of code complex, it is complex.
19. Check complexity at every level: lines, functions, classes, modules.
20. Reject a change on any of the three symptoms: a local change forces changes elsewhere; the code costs more to hold in the head than the task warrants; the code cannot tell the reader what else must be touched.
21. Do not count lines. More lines that are each simple are simpler than fewer lines that are each complex.
22. Separate the complexity the problem itself has from the complexity we introduced. Only the second can be removed.
23. Reduce mutable state first and ordering second.
24. Do not weave together what can be expressed apart.
25. Reject over-engineering as a form of complexity: code made more generic than it needs to be, or functionality not presently needed. Solve the problem that is known now; the future problem gets solved when its actual shape is visible.
26. Prevent small complexities. Systems become complex through many small changes that add up, so a small degradation is not acceptable on the grounds of being small.

## 5. Comments

27. Write the reason the code exists. Do not write what the code does.
28. Rewrite the code simpler when a comment is needed to explain what it does.
29. Comment a regular expression and a non-trivial algorithm — there the reader needs to know what, and the code cannot say it.
30. Keep interface documentation distinct from comments: it states the purpose, how the thing is used, and how it behaves when used.
31. Keep implementation detail out of interface documentation.
32. Rewrite a unit whose interface documentation has grown long, and a unit that is hard to describe.
33. Remove a comment that repeats the code, a comment that is out of date, and a marker that no longer applies.

## 6. Names

34. Make a name long enough to fully communicate what the thing is or does, and not so long that it becomes hard to read.
35. Agree one term per concept with the people who know the domain, and use those terms in conversation, in the design, and down into the source.
36. Replace a vague name. Treat a name that is hard to pick as a sign that the thing it names is not one thing.
37. Let the language change as understanding of the domain grows, and change it everywhere at once.

## 7. Dependencies

38. Inspect a dependency before taking it, on: documentation and API design; code quality, read some; tests, run them; open and fixed issues in the tracker; how long and how actively it has been maintained; how many others depend on it; robustness against untrusted input and its record in the vulnerability database; licence; and its own transitive dependencies.
39. Write your own tests against the dependency, covering what your application actually needs, and keep them. Turn the throwaway program you wrote to try it into one of those tests.
40. Define your own interface and a thin wrapper over the dependency. Put in the wrapper only what your project needs, not everything the dependency offers.
41. Copy a small piece rather than depend on a whole package for it, preserving the notices. A little copying is better than a little dependency.
42. Upgrade promptly rather than late, once your own tests for the dependency exist; read the diffs or the release notes on upgrade and re-run both your tests and the package's own.
43. Do not upgrade automatically without that verification.
44. Record the hash of the version you use and verify it on every fetch.
45. Watch for indirect dependencies appearing on upgrade, and treat an unused import as an error.
46. Revisit a dependency that has stopped changing, and drop one whose security record shows a pattern.

## 8. Checks

47. Run analysis automatically on every change and show the result next to the diff, where the author is already in a change mindset, has time to wait, and has to convince a reviewer to ignore it.
48. Report only on what the change introduced. Leave existing issues in working code alone unless they are security issues or significant bugs — fixing a warning can introduce a bug.
49. Hold a check shown at review time to four bars: its output is understandable; it says how to fix the issue; fewer than one in ten results is an effective false positive; and it has real impact on code quality.
50. Count a result as an effective false positive whenever the developer took no positive action, including when the tool was right but the message was unclear or the issue was unimportant.
51. Fix the message before removing the check. An unclear message produces the same reaction as a wrong one.
52. Hold a check that breaks the build to a stricter bar: it must be mechanically fixable, it must never fire on correct code, and it must concern correctness rather than style or best practice.
53. Clean up every existing instance before turning a blocking check on.
54. Do not issue warnings. Either the check breaks the build, or it is not shown.
55. Fix automatically anything that can be fixed automatically, formatting first. Pointing out formatting is not a use of a reviewer's time.
56. Customise checks per project, never per developer. Per-developer suppression hides bugs and silences the feedback that would have fixed the check.
57. Give developers a channel to mark a result useless, and disable a check whose results are routinely marked useless.
58. Do not expect tools to find the debt that matters. They see a small fraction. They can, however, flag circumstantial evidence — for instance two files that are always changed together.

## 9. Decision records

59. Write one record per decision that is expensive to reverse, in five sections: title, context, decision, status, consequences.
60. Keep it to one or two pages, in full sentences, addressed to a future developer.
61. State the context in value-neutral language, including the technical, political, social and project forces at play.
62. State the decision in the active voice.
63. List the consequences that are positive, negative and neutral.
64. Number records sequentially, never reuse a number, and keep a reversed record marked superseded rather than deleting it.

## 10. Divergence between ideas and code

65. Expect your understanding of the problem to outgrow the code you already wrote. That gap is the debt, and it appears even when the work was done well.
66. Rewrite the code to match the understanding you now have. Cunningham calls this consolidation; it is what repayment means.
67. Write code clean enough to be refactored later. Hacky code and first-draft code cannot be consolidated, which removes the thing that makes iterative work viable.
68. Do not develop by accretion. Adding features without reorganising to reflect what you have learned ends with a program that contains no understanding, where everything takes longer and longer.
69. Make consolidation part of the schedule, not side work. Iterative development without a process for restructuring code has bankruptcy as its exit strategy.
70. Spend time up front on the architecture. Those decisions are the most expensive to change later, so buy back the foreseeable dead ends before starting.
71. Rewrite the program to look as if you had known what you were doing all along, and as if it had been easy.
72. Do not commit code you would be uncomfortable having used to teach programming.

## 11. Broken windows

73. Fix a thing you know is wrong the moment you find it — in the code, the process, the requirements or the documentation.
74. Where you cannot fix it now, mark it so that nobody trusts it: put an assertion at the spot so that it fires if the case is ever hit, and say plainly that it is broken.
75. Show you are on top of it. Visible neglect tells everyone else that this is the standard here, and bad code does collateral damage far beyond its own function.
76. Keep order during an emergency too. Roll out the carpet before you bring the hoses in.

## 12. Config

77. Keep out of the code everything that is likely to vary between deploys: handles to databases and backing services, credentials to external services, and per-deploy values such as hostnames.
78. Keep internal wiring that does not vary between deploys in the code. That is not config.
79. Satisfy the test: the codebase could be made open source at any moment without compromising any credentials.
80. Do not batch settings into named groups such as development, test and production. New deploys need new names, and the names multiply. Keep each setting independent of the others and set per deploy.
81. Prefer environment variables to a config file kept out of version control: a file is easy to commit by accident, scatters into several places and formats, and ties you to one language.
82. Validate the whole config at startup and refuse to start on failure.

## 13. Inputs and flow

83. Parse, do not validate. A check that returns nothing throws away what it learned; a parser returns a more precise type that carries the proof.
84. Strengthen the argument type rather than weakening the return type. Make the wrong call impossible instead of returning something the caller must re-check.
85. Use a data structure that makes illegal states unrepresentable, and model with the most precise structure that reasonably fits.
86. Push the burden of proof upward as far as possible, but no further. Get data into its precise representation at the boundary, before anything acts on it.
87. Split the program into parsing and execution, so that failure from invalid input can only happen in the first.
88. Do not spread checks through the processing code. Partially processed invalid input leaves a state you cannot predict and often cannot roll back.
89. Treat a function that returns nothing but success with deep suspicion.
90. Parse in several passes where that helps. Using some input to decide how to parse the rest is not the thing being forbidden.
91. Avoid denormalised representations, above all mutable ones; where one is necessary, keep it behind an abstraction that is solely responsible for keeping the copies in sync.
92. Wrap a check you cannot express in the type system in an abstract type with one constructor, so it behaves like a parser.
93. Write functions against the representation you want, then close the gap from both ends.
94. Document the invariant in a comment where none of the above is practical.

## 14. Errors

95. Define errors out of existence where the interface allows it. Removing a case is better than handling it.
96. Reduce the number of places that must handle an error rather than the number of errors.
97. Expect recovery to be the hard part: reverting is hard, repairing and continuing is hard, and both end in inconsistency.

*Example: an operation that ensures a name is absent has no error case; one that removes an existing name has one. Returning nothing for an out-of-range slice removes a case that throwing would create.*

## 15. Review

98. Cover a change in this order: design, functionality, complexity, tests, naming, comments, style, consistency, documentation.
99. Read every line you were assigned. Say so when you reviewed only part of it.
100. Ask the author to clarify code you cannot follow, rather than approving it. If you cannot understand it, the next reader will not either.
101. Bring in a qualified reviewer for privacy, security, concurrency, accessibility and internationalisation.
102. Look outside the diff: at the whole file, and at what the change does to the system.
103. Require tests in the same change as the code, except in an emergency. Ask whether each test would actually fail if the code broke.
104. Hold tests to the same standard as the code. Tests do not test themselves.
105. Mark a suggestion you are not requiring, and do not block on personal preference.
106. Send a large reformatting as its own change, never combined with a functional one.
107. Follow the style guide where it requires; otherwise match the surrounding code, and file the cleanup.
108. Approve once the change definitely improves the health of the system, even when it is not perfect. Do not approve one that degrades it.
109. Say what was done well, not only what was wrong.