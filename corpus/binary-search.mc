// Binary search, including two misses and both endpoints.
int find(int[] a, int n, int want) {
  int lo = 0;
  int hi = n - 1;
  while (lo <= hi) {
    int mid = lo + (hi - lo) / 2;
    if (a[mid] == want) return mid;
    if (a[mid] < want) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

int main() {
  int a[6] = {2, 4, 6, 8, 10, 12};
  print(find(a, 6, 8));
  print(find(a, 6, 5));
  print(find(a, 6, 2));
  print(find(a, 6, 12));
  return 0;
}
