// Insertion sort. The inner loop depends on short-circuiting for correctness:
// `j >= 0 && a[j] > key` must not read a[-1] when j reaches -1.
void sort(int[] a, int n) {
  for (int i = 1; i < n; i = i + 1) {
    int key = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] > key) {
      a[j + 1] = a[j];
      j = j - 1;
    }
    a[j + 1] = key;
  }
}

int main() {
  int a[10] = {5, 3, 9, 1, 7, 3, 8, 2, 6, 4};
  sort(a, 10);
  for (int i = 0; i < 10; i = i + 1) print(a[i]);
  return 0;
}
