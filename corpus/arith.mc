// Wrapping, truncating division, remainder signs, shifts and bitwise ops --
// every case docs/semantics.md is explicit about, short of the traps.
int main() {
  print(2147483647 + 1);
  print(-2147483648 - 1);
  print(-(-2147483648));
  print(65536 * 65536);
  print(2147483647 * 2);

  print(7 / 2);
  print(-7 / 2);
  print(7 / -2);
  print(-7 / -2);
  print(7 % 2);
  print(-7 % 2);
  print(7 % -2);
  print(-7 % -2);
  print(-2147483648 / 1);

  print(1 << 31);
  print(1 << 32);
  print(1 << 33);
  print(-8 >> 1);
  print(-1 >> 31);
  print(255 & 15);
  print(5 | 2);
  print(5 ^ 3);
  print(~0);
  return 0;
}
