// Two identical calls are two events, not one expression. A pass that merges
// them by value prints a single line.
int tell(int x) {
  print(x);
  return x;
}

int main() {
  int a = tell(5);
  int b = tell(5);
  print(a + b);
  return 0;
}
