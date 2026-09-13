// Quicksort: recursion, an array passed by reference, and swaps through it.
int partition(int[] a, int lo, int hi) {
  int pivot = a[hi];
  int i = lo - 1;
  for (int j = lo; j < hi; j = j + 1) {
    if (a[j] <= pivot) {
      i = i + 1;
      int t = a[i]; a[i] = a[j]; a[j] = t;
    }
  }
  int t = a[i + 1]; a[i + 1] = a[hi]; a[hi] = t;
  return i + 1;
}

void quicksort(int[] a, int lo, int hi) {
  if (lo < hi) {
    int p = partition(a, lo, hi);
    quicksort(a, lo, p - 1);
    quicksort(a, p + 1, hi);
  }
}

int main() {
  int a[8] = {5, 3, 9, 1, 7, 3, 8, 2};
  quicksort(a, 0, 7);
  for (int i = 0; i < 8; i = i + 1) print(a[i]);
  return 0;
}
