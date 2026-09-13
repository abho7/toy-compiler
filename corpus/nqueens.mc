// Six queens on a six by six board. There are four solutions.
int safe(int[] col, int row, int c) {
  for (int r = 0; r < row; r = r + 1) {
    int d = col[r] - c;
    if (d < 0) d = -d;
    if (col[r] == c || d == row - r) return 0;
  }
  return 1;
}

int solve(int[] col, int n, int row) {
  if (row == n) return 1;
  int total = 0;
  for (int c = 0; c < n; c = c + 1) {
    if (safe(col, row, c)) {
      col[row] = c;
      total = total + solve(col, n, row + 1);
    }
  }
  return total;
}

int main() {
  int col[6];
  print(solve(col, 6, 0));
  return 0;
}
