// The index is out of range and the right-hand side traps. The document fixes
// the order -- index, value, bounds check, store -- so the division trap is
// the one observed, not the out-of-bounds one.
int main() {
  int a[1];
  int z = 0;
  a[7] = 100 / z;
  return 0;
}
