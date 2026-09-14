// A load whose result nobody uses still checks its bounds. An optimizer that
// deletes instructions merely because nothing reads them deletes this trap.
int main() {
  int a[3];
  print(1);
  a[5];
  return 0;
}
