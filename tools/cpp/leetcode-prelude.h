// What LeetCode adds around a C++ submission: the headers, `using namespace
// std;` and its data-structure definitions. tools/prefill.mjs puts this in
// front of each solution before `clang++ -fsyntax-only`.
#include <bits/stdc++.h>
using namespace std;

struct ListNode {
  int val; ListNode *next;
  ListNode() : val(0), next(nullptr) {}
  ListNode(int x) : val(x), next(nullptr) {}
  ListNode(int x, ListNode *next) : val(x), next(next) {}
};

struct TreeNode {
  int val; TreeNode *left; TreeNode *right;
  TreeNode() : val(0), left(nullptr), right(nullptr) {}
  TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
  TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {}
};

// "Node" differs per problem (graph, N-ary tree, random-pointer list, next
// pointers); this superset covers the common ones
class Node {
public:
  int val;
  vector<Node*> neighbors, children;
  Node *next = nullptr, *random = nullptr, *left = nullptr, *right = nullptr, *prev = nullptr, *child = nullptr, *parent = nullptr;
  Node() : val(0) {}
  Node(int v) : val(v) {}
  Node(int v, vector<Node*> c) : val(v), neighbors(c), children(c) {}
  Node(int v, Node* l, Node* r, Node* n) : val(v), next(n), left(l), right(r) {}
};
