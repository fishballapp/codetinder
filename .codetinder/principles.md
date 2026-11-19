<!-- codetinder principles · format 3 · edit freely, keep the ids -->
# Coding principles

Learned from this project's swipes on https://codetinder.dev

## General

### guard-clauses · strong
Handle special cases with early returns (guard clauses) and keep the main path flat. Don't pack every condition into one boolean expression, don't nest the main path inside an if, and don't replace a guard with a ternary.

### descriptive-parameter-names · strong
Give callback and function parameters descriptive names such as left and right, or request rather than req, not single letters or abbreviations, even in short comparators. Name an unused parameter too (`_part`, not a bare `_`).

### skip-redundant-doc-comments · strong
Don't put a comment, doc or inline, on code whose name and signature already make its purpose clear.

### name-values-for-their-role · strong
Name a variable for the role it plays, not a vague word like from, base, result, sentence or a bare text, and don't rename a field to a vaguer name when it is destructured. Rename a vague destructured field to a more descriptive one when that clarifies its role.

### order-guard-checks-first · tentative
In a compound condition, put the cheap guard check (such as an undefined check or a plain boolean) first, before the calls that depend on it or cost more.

### use-set-for-membership-checks · moderate
When testing membership against a collection inside a loop or filter, build a set once and look values up in it instead of searching an array on every iteration.

### extract-repeated-logic-into-helpers · tentative
When the same expression is written out more than once, extract it into a small named helper function and call it instead of repeating it.

### prefer-collection-methods-over-loops · tentative
Build or search a sequence with the language's collection operations (map, find, filter) instead of a hand-written index loop with a mutable counter.

### keep-single-use-logic-inline · moderate
Keep logic that only one function uses inside that function. Don't extract it into a separate top-level helper.

### keep-trivial-expressions-inline · tentative
Use a trivial expression such as a collection's length directly. Don't bind it to an alias variable just to shorten repeated uses.

### derive-values-from-existing-ones · tentative
When a value follows from values already computed, derive it with simple arithmetic instead of recomputing it with another pass over the data.

### simplify-boolean-expressions · tentative
Express a boolean result directly with &&, || and !, not with a ternary that picks between a value and a literal true or false.

### name-booleans-as-predicates · tentative
Name a boolean variable as a predicate with a prefix such as is or has (`isMoved`, not `moved`).

### check-undefined-explicitly · tentative
Test for a missing value with an explicit comparison to undefined, not a truthiness check on a value that could be falsy for other reasons.

## TypeScript

### expression-bodied-arrows · strong
Keep a function whose body is a single expression as an expression-bodied arrow function. Don't convert an arrow function to a function declaration or a block body with return, unless the body chooses between outcomes and reads better as a guard clause.

### destructure-object-parameters · strong
Destructure the fields a callback needs in its parameter list. Don't take the whole object and repeat its name on every property access.

### use-optional-chaining · moderate
Use optional chaining and nullish coalescing to handle a missing value. Don't spell it out as a separate variable or an explicit undefined check followed by a property access.

### short-circuit-conditional-rendering · tentative
Render an optional JSX fragment with `condition && <fragment>`. Don't write a ternary whose other branch is null.

### infer-types-from-initializer · moderate
Let the compiler infer a variable's type from its initializer, for example `new Set<T>()`. Don't add a redundant type annotation on the variable.

### spread-to-combine-arrays · tentative
Combine arrays with spread (`[...left, ...right]`), not `concat`.
