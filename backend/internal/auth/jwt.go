package auth

import (
	"fmt"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func IssueToken(secret string, userID int64, email string, ttl time.Duration) (string, error) {
	claims := jwt.MapClaims{
		"sub":   strconv.FormatInt(userID, 10),
		"email": email,
		"exp":   time.Now().Add(ttl).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

func ParseToken(secret, tokenStr string) (userID int64, email string, err error) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(secret), nil
	})
	if err != nil {
		return 0, "", err
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok || !token.Valid {
		return 0, "", fmt.Errorf("invalid token")
	}
	sub, ok := claims["sub"].(string)
	if !ok {
		return 0, "", fmt.Errorf("missing sub")
	}
	userID, err = strconv.ParseInt(sub, 10, 64)
	if err != nil {
		return 0, "", err
	}
	email, _ = claims["email"].(string)
	return userID, email, nil
}
