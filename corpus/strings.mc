// Text as an int array: a string literal initializer, a zero terminator,
// length, reversal in place, and bytes out through putchar.
int length(int[] s) {
  int n = 0;
  while (s[n] != 0) n = n + 1;
  return n;
}

void emit(int[] s, int n) {
  for (int i = 0; i < n; i = i + 1) putchar(s[i]);
  putchar(10);
}

void reverse(int[] s, int n) {
  for (int i = 0; i < n / 2; i = i + 1) {
    int t = s[i];
    s[i] = s[n - 1 - i];
    s[n - 1 - i] = t;
  }
}

int main() {
  int s[] = "hello";
  int n = length(s);
  print(n);
  emit(s, n);
  reverse(s, n);
  emit(s, n);
  return 0;
}
