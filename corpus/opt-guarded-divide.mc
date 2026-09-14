// The division is safe only because of the guard. Any pass that moves it out
// of the branch -- to share it with the one below, say -- introduces a trap in
// a program that has none.
int divide(int n) {
  if (n != 0) return 100 / n;
  return 0;
}

int main() {
  print(divide(5));
  print(divide(0));
  print(divide(4));
  return 0;
}
