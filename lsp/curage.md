# Curage-lang

## Syntax

Curage-lang's syntax is a subset of JavaScript. The following describes the syntax in PEG-like notation.

```fsharp
number =
    digit+

name =
    (alphabet / digit / "_")+

expression =
    integer
    / name
    / "(" expression ")"

statement =
    / "let" name "=" expression
    / expression

program =
    (statement ";")*
```

- Note that:
    - `A*` means a sequence of `A` or empty,
    - `A+` means a sequence of `A` at least one,
    - `A / B` means `A` or `B`.

## Example

```js
    let answer = 42;
    print(answer);
```

```
42
```
