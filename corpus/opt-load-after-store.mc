// Two loads of the same element with a store in between. Common subexpression
// elimination that treats them as one expression prints 1 twice.
int main() {
  int a[2];
  a[0] = 1;
  int first = a[0];
  a[0] = 2;
  int second = a[0];
  print(first);
  print(second);
  return 0;
}
