// Plenty for constant folding to do, including expressions whose value is
// known but whose evaluation must not be: the division by zero below is
// reached only when the guard allows it, and is never folded away.
int main() {
  int a = 2 + 3 * 4;
  int b = (100 - 50) / 5;
  int c = 1 << 4;
  int d = a * 0;
  int e = b - b;
  int f = c | 0;
  print(a); print(b); print(c); print(d); print(e); print(f);

  if (1) print(7);
  if (0) print(8);

  int z = 0;
  if (z != 0) print(100 / z);
  return 0;
}
