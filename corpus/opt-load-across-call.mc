// The callee writes through the array it was handed, so the second load must
// not be replaced by the first. A pass that assumes a call changes nothing
// prints 7 twice.
void bump(int[] a) {
  a[0] = a[0] + 1;
}

int main() {
  int a[1];
  a[0] = 7;
  int before = a[0];
  bump(a);
  int after = a[0];
  print(before);
  print(after);
  return 0;
}
