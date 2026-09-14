// The same, for division: the result is discarded, the trap is not.
int main() {
  int z = 0;
  print(1);
  100 / z;
  return 0;
}
