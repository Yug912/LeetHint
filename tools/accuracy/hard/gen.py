# Writes a C++ test driver per problem: LeetCode's examples, random small cases
# checked against a brute force written from the statement, and max-size
# inputs timed for TLE.
import random, os
random.seed(7)
MOD = 10**9 + 7
OUT = os.path.join(os.path.dirname(__file__), 'drivers')
os.makedirs(OUT, exist_ok=True)

vec = lambda a: '{' + ','.join(map(str, a)) + '}'
vec2 = lambda a: '{' + ','.join(vec(x) for x in a) + '}'
cstr = lambda s: '"' + s + '"'

# ── brute forces, straight from the statements ──
def b3266(nums, k, m):
    a = list(nums)
    for _ in range(k):
        i = a.index(min(a)); a[i] *= m
    return [x % MOD for x in a]

def b3463(s):
    while len(s) > 2:
        s = ''.join(str((int(s[i]) + int(s[i + 1])) % 10) for i in range(len(s) - 1))
    return s[0] == s[1]

def b3165(nums, queries):
    a = list(nums); total = 0
    for p, x in queries:
        a[p] = x
        take, skip = 0, 0            # best sum ending with/without taking the current element
        for v in a:
            take, skip = skip + v, max(take, skip)
        total += max(take, skip, 0)
    return total % MOD

def b2612(n, p, banned, k):
    ban = set(banned); dist = [-1] * n; dist[p] = 0; q = [p]
    for i in q:
        for L in range(0, n - k + 1):
            if L <= i <= L + k - 1:
                j = L + (L + k - 1) - i
                if j not in ban and dist[j] == -1:
                    dist[j] = dist[i] + 1; q.append(j)
    return dist

def b2945(nums):
    n = len(nums); best = 0
    for mask in range(1 << (n - 1)):
        sums, cur = [], 0
        for i, v in enumerate(nums):
            cur += v
            if i == n - 1 or mask >> i & 1: sums.append(cur); cur = 0
        if all(sums[i] <= sums[i + 1] for i in range(len(sums) - 1)): best = max(best, len(sums))
    return best

def write(slug, lines, perf):
    with open(os.path.join(OUT, slug + '.inc'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    with open(os.path.join(OUT, slug + '.perf'), 'w') as f:
        f.write(perf + '\n')

R = 300

# 3266
L = ['{vector<int> a={2,1,3,5,6}; EX(S().getFinalState(a,5,2)==vector<int>{8,4,6,5,6});}',
     '{vector<int> a={100000,2000}; EX(S().getFinalState(a,2,1000000)==vector<int>{999999307,999999993});}',
     '{vector<int> a={5,3,7}; RND(S().getFinalState(a,1000000000,1)==vector<int>{5,3,7});}']
for _ in range(R):
    n = random.randint(1, 6); big = random.random() < 0.3
    nums = [random.randint(1, 10**9 if big else 20) for _ in range(n)]
    k = random.randint(1, 25 if big else 60); m = random.randint(1, 10**6 if big else 5)
    L.append(f'{{vector<int> a={vec(nums)}; RND(S().getFinalState(a,{k},{m})==vector<int>{vec(b3266(nums, k, m))});}}')
write('final-array-state-after-k-multiplication-operations-ii', L,
      '{vector<int> a(10000); for(int i=0;i<10000;i++) a[i]=1+(i*7919)%1000000000; auto r=S().getFinalState(a,1000000000,2); sink+=r[0];}'
      '{vector<int> a(10000,1); auto r=S().getFinalState(a,1000000000,1000000); sink+=r[0];}')

# 3463
L = ['EX(S().hasSameDigits("3902")==true);', 'EX(S().hasSameDigits("34789")==false);']
for _ in range(R):
    s = ''.join(random.choice('0123456789' if random.random() < 0.7 else '05') for _ in range(random.randint(3, 40)))
    L.append(f'RND(S().hasSameDigits({cstr(s)})=={str(b3463(s)).lower()});')
write('check-if-digits-are-equal-in-string-after-operations-ii', L,
      '{string s(100000,\'0\'); for(int i=0;i<100000;i++) s[i]=\'0\'+(i*31+7)%10; sink+=S().hasSameDigits(s);}')

# 3165
L = ['{vector<int> a={3,5,9}; vector<vector<int>> q={{1,-2},{0,-3}}; EX(S().maximumSumSubsequence(a,q)==21);}',
     '{vector<int> a={0,-1}; vector<vector<int>> q={{0,-5}}; EX(S().maximumSumSubsequence(a,q)==0);}']
for _ in range(R):
    n = random.randint(1, 10); nums = [random.randint(-10**5, 10**5) for _ in range(n)]
    qs = [[random.randrange(n), random.randint(-10**5, 10**5)] for _ in range(random.randint(1, 10))]
    L.append(f'{{vector<int> a={vec(nums)}; vector<vector<int>> q={vec2(qs)}; RND(S().maximumSumSubsequence(a,q)=={b3165(nums, qs)});}}')
write('maximum-sum-of-subsequence-with-non-adjacent-elements', L,
      '{vector<int> a(50000); for(int i=0;i<50000;i++) a[i]=(i*7919)%200001-100000; vector<vector<int>> q(50000); for(int i=0;i<50000;i++) q[i]={(i*104729)%50000,(i*31)%200001-100000}; sink+=S().maximumSumSubsequence(a,q);}')

# 2612
L = ['{vector<int> b={1,2}; EX(S().minReverseOperations(4,0,b,4)==vector<int>{0,-1,-1,1});}',
     '{vector<int> b={2,4}; EX(S().minReverseOperations(5,0,b,3)==vector<int>{0,-1,-1,-1,-1});}',
     '{vector<int> b={0,1,3}; EX(S().minReverseOperations(4,2,b,1)==vector<int>{-1,-1,0,-1});}']
for _ in range(R):
    n = random.randint(1, 14); p = random.randrange(n); k = random.randint(1, n)
    banned = random.sample([i for i in range(n) if i != p], random.randint(0, min(n - 1, 4)))
    L.append(f'{{vector<int> b={vec(banned)}; RND(S().minReverseOperations({n},{p},b,{k})==vector<int>{vec(b2612(n, p, banned, k))});}}')
write('minimum-reverse-operations', L,
      '{vector<int> b; auto r=S().minReverseOperations(100000,0,b,50001); sink+=r[1];}'
      '{vector<int> b; auto r=S().minReverseOperations(100000,0,b,3); sink+=r[2];}')

# 2945
L = ['{vector<int> a={5,2,2}; EX(S().findMaximumLength(a)==1);}', '{vector<int> a={1,2,3,4}; EX(S().findMaximumLength(a)==4);}',
     '{vector<int> a={4,3,2,6}; EX(S().findMaximumLength(a)==3);}']
for _ in range(R):
    nums = [random.randint(1, 10 if random.random() < 0.7 else 10**5) for _ in range(random.randint(1, 13))]
    L.append(f'{{vector<int> a={vec(nums)}; RND(S().findMaximumLength(a)=={b2945(nums)});}}')
write('find-maximum-non-decreasing-array-length', L,
      '{vector<int> a(100000); for(int i=0;i<100000;i++) a[i]=1+(i*7919)%100000; sink+=S().findMaximumLength(a);}'
      '{vector<int> a(100000); for(int i=0;i<100000;i++) a[i]=100000-i; sink+=S().findMaximumLength(a);}')
print('drivers written')
