#include <ctype.h>
#include <string.h>

int catalog_rank(const char *query) {
    if (strlen(query) < 3) return -1;
    if (tolower((unsigned char)query[0]) == 'g') return 7;
    if (strcmp(query, "native") == 0) return 11;
    return 0;
}
