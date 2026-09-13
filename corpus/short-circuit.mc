// The right operand of && and || is not evaluated when the left decides, so
// neither the printing nor the division below ever happens.
int boom() {
  print(999);
  return 1;
}

int main() {
  if (0 && boom()) print(1);
  if (1 || boom()) print(2);

  int z = 0;
  if (z != 0 && 100 / z > 0) print(3);
  if (z == 0 || 100 / z > 0) print(4);

  print(0 && 1);
  print(1 && 2);
  print(0 || 0);
  print(3 || 0);
  return 0;
}
