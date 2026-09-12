# minic, the language

A small imperative language: integers, integer arrays, functions, loops, conditionals. It is
meant to be big enough to write a sorting algorithm or a small interpreter in, and small enough
that a compiler for it can be checked rather than merely tested.

What it *means* is in [semantics.md](semantics.md). This document is the syntax.

## A program

```c
int partition(int[] a, int lo, int hi) {
  int pivot = a[hi];
  int i = lo - 1;
  for (int j = lo; j < hi; j = j + 1) {
    if (a[j] <= pivot) {
      i = i + 1;
      int t = a[i]; a[i] = a[j]; a[j] = t;
    }
  }
  int t = a[i + 1]; a[i + 1] = a[hi]; a[hi] = t;
  return i + 1;
}

void quicksort(int[] a, int lo, int hi) {
  if (lo < hi) {
    int p = partition(a, lo, hi);
    quicksort(a, lo, p - 1);
    quicksort(a, p + 1, hi);
  }
}

int main() {
  int a[8] = {5, 3, 9, 1, 7, 3, 8, 2};
  quicksort(a, 0, 7);
  for (int i = 0; i < 8; i = i + 1) print(a[i]);
  return 0;
}
```

## Grammar

```ebnf
program     = { function } ;
function    = ( "int" | "void" ) IDENT "(" [ params ] ")" block ;
params      = param { "," param } ;
param       = "int" IDENT | "int" "[" "]" IDENT ;

block       = "{" { statement } "}" ;
statement   = block
            | declaration
            | "if" "(" expr ")" statement [ "else" statement ]
            | "while" "(" expr ")" statement
            | "for" "(" [ forinit ] ";" [ expr ] ";" [ expr ] ")" statement
            | "break" ";"
            | "continue" ";"
            | "return" [ expr ] ";"
            | expr ";"
            | ";" ;
forinit     = declaration_nosemi | expr ;

declaration = "int" IDENT [ "=" expr ] ";"
            | "int" IDENT "[" expr "]" [ "=" initializer ] ";"
            | "int" IDENT "[" "]" "=" STRING ";" ;
initializer = "{" [ expr { "," expr } ] "}" | STRING ;

expr        = assignment ;
assignment  = IDENT "=" assignment
            | IDENT "[" expr "]" "=" assignment
            | logic_or ;
logic_or    = logic_and { "||" logic_and } ;
logic_and   = bit_or { "&&" bit_or } ;
bit_or      = bit_xor { "|" bit_xor } ;
bit_xor     = bit_and { "^" bit_and } ;
bit_and     = equality { "&" equality } ;
equality    = relational { ( "==" | "!=" ) relational } ;
relational  = shift { ( "<" | "<=" | ">" | ">=" ) shift } ;
shift       = additive { ( "<<" | ">>" ) additive } ;
additive    = multiplicative { ( "+" | "-" ) multiplicative } ;
multiplicative = unary { ( "*" | "/" | "%" ) unary } ;
unary       = ( "-" | "!" | "~" ) unary | postfix ;
postfix     = primary { "[" expr "]" } ;
primary     = INT | CHAR | IDENT | IDENT "(" [ args ] ")" | "(" expr ")" ;
args        = expr { "," expr } ;
```

Precedence runs from `||` (loosest) down to unary operators (tightest), as in C. Binary operators
are left-associative; assignment is right-associative.

## Lexical structure

- **Identifiers**: `[A-Za-z_][A-Za-z0-9_]*`, case-sensitive, and not one of the keywords
  `int void if else while for break continue return`.
- **Integer literals**: decimal (`42`), hexadecimal (`0x2a`), or binary (`0b101010`). A literal
  that does not fit in 32 bits is a compile error rather than a wrapped value.
- **Character literals**: `'a'`, `'\n'`, `'\t'`, `'\\'`, `'\''`, `'\0'` — an `int` holding the
  byte value.
- **String literals**: `"hi\n"` — usable only as an array initializer, where it becomes the byte
  values followed by a terminating `0`.
- **Comments**: `// to end of line` and `/* ... */`, which do not nest.
- Whitespace separates tokens and is otherwise insignificant.

## Arrays

`int a[n];` declares an array of `n` elements, where `n` is a constant expression greater than
zero. Elements start at `0`, or at the values given by an initializer:

```c
int a[4];                    // 0, 0, 0, 0
int b[4] = {1, 2};           // 1, 2, 0, 0
int c[] = {1, 2, 3};         // length inferred: 3
int s[] = "hi";              // 'h', 'i', 0  -- length 3
```

An array is passed to a function as `int[]`, by reference, carrying its length, so the callee's
bounds checks are real:

```c
int sum(int[] xs, int n) { ... }
```

There are no array-typed local variables other than parameters, no array assignment (`a = b`),
and no returning an array. A reference therefore never outlives the array it refers to, which is
why lifetimes need no further rules.

## What the language deliberately does not have

No structs, pointers, globals, floats, strings as a type, `switch`, `do`/`while`, increment
operators, compound assignment, or the comma operator. Each was left out because it would widen
the semantics the optimizer has to preserve without adding a program worth compiling: the goal is
a language small enough to *verify* a compiler for, in which quicksort and a bytecode interpreter
are still natural to write.
