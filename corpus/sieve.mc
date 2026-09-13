// Sieve of Eratosthenes below 30, then the count of what it found.
int main() {
  int n = 30;
  int mark[30];
  int count = 0;
  for (int i = 2; i < n; i = i + 1) {
    if (mark[i] == 0) {
      count = count + 1;
      print(i);
      for (int j = i * i; j < n; j = j + i) mark[j] = 1;
    }
  }
  print(count);
  return 0;
}
