// The same number two ways: deep recursion, and a loop.
int fib(int n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

int main() {
  print(fib(20));
  int a = 0;
  int b = 1;
  for (int i = 0; i < 20; i = i + 1) {
    int t = a + b;
    a = b;
    b = t;
  }
  print(a);
  return 0;
}
