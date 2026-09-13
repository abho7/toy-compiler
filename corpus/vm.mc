// A stack machine, written in minic, running a program that sums 1 to 10.
//
// The point of this one: a language that can host an interpreter for another
// language is expressive enough to be worth compiling well.
//
//    0 HALT      1 PUSH n    2 ADD       5 LT      6 JMPF a
//    7 JMP a    10 PRINT    11 LOAD i   12 STORE i
int main() {
  int code[40] = {
     1, 0,   12, 0,    1, 1,   12, 1,
    11, 1,    1, 11,   5, 0,    6, 17,
    11, 0,   11, 1,    2, 0,   12, 0,
    11, 1,    1, 1,    2, 0,   12, 1,
     7, 4,   11, 0,   10, 0,    0, 0
  };
  int stack[64];
  int var[8];
  int sp = 0;
  int pc = 0;

  while (1) {
    int op = code[pc * 2];
    int arg = code[pc * 2 + 1];
    pc = pc + 1;
    if (op == 0) return 0;
    if (op == 1) { stack[sp] = arg; sp = sp + 1; }
    if (op == 2) { sp = sp - 1; stack[sp - 1] = stack[sp - 1] + stack[sp]; }
    if (op == 5) { sp = sp - 1; stack[sp - 1] = stack[sp - 1] < stack[sp]; }
    if (op == 6) { sp = sp - 1; if (stack[sp] == 0) pc = arg; }
    if (op == 7) pc = arg;
    if (op == 10) { sp = sp - 1; print(stack[sp]); }
    if (op == 11) { stack[sp] = var[arg]; sp = sp + 1; }
    if (op == 12) { sp = sp - 1; var[arg] = stack[sp]; }
  }
}
