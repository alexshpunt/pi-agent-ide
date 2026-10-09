#include <stdio.h>

int catalog_rank(const char *query);

int main(int argc, char **argv) {
    if (argc != 2) {
        fputs("usage: catalog QUERY\n", stderr);
        return 2;
    }
    printf("%d\n", catalog_rank(argv[1]));
    return 0;
}
